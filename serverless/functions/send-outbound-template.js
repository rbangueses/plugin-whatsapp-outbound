const TokenValidator = require('twilio-flex-token-validator').validator;

// Send-and-open-chat: create conversation, send template, wrap in a Flex
// Interaction so a chat task is created and routed to the sending agent.
//
// Also writes a "send" entry to the per-agent Sync Map for history/tracking
// and registers a per-conversation webhook so lifecycle events (delivered,
// read, replied) update the same entry.
exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  let tokenResult;
  try {
    tokenResult = await TokenValidator(event.Token, context.ACCOUNT_SID, context.AUTH_TOKEN);
  } catch (e) {
    response.setStatusCode(401);
    response.setBody({ error: 'Invalid Flex token' });
    return callback(null, response);
  }

  const { To, ContentSid, ContentVariables, WorkerSid, TemplateName, ExistingConversationSid } = event;
  if (!To || !ContentSid || !WorkerSid) {
    response.setStatusCode(400);
    response.setBody({ error: 'Missing required parameters: To, ContentSid, WorkerSid' });
    return callback(null, response);
  }

  const client = context.getTwilioClient();
  const toE164 = String(To).trim();
  const customerAddress = `whatsapp:${toE164}`;
  const proxyAddress = `whatsapp:${context.WHATSAPP_FROM}`;
  const workerName = (tokenResult && tokenResult.identity) || 'agent';
  const autoCloseAfter = context.AUTO_CLOSE_AFTER || 'P5D';

  // Captured in the ExistingConversationSid branch and consumed AFTER the send
  // succeeds. All mutations of the previous owner's state (conversation
  // ownership attrs AND the Sync row deletion) are deferred until messages.create
  // returns successfully, so a mid-send failure leaves everything with the
  // previous owner intact.
  let previousOwnerSid = null;
  let previousOwnerRowData = null;
  let deferredOwnershipAttrs = null;

  try {
    let conversation;
    if (ExistingConversationSid) {
      // Reopen-with-template path: use the existing conversation so history
      // is preserved. Skip participant + webhook creation (both already set).
      // Attribute mutations (ownership transfer, timer refresh, lastReopen*,
      // taskCreated reset) are prepared here but APPLIED after messages.create
      // succeeds -- see below.
      const existing = await client.conversations.v1.conversations(ExistingConversationSid).fetch();
      if (existing.state === 'closed') {
        response.setStatusCode(409);
        response.setBody({ error: 'Existing conversation is closed; create a new one instead.' });
        return callback(null, response);
      }
      const existingAttrs = safeJson(existing.attributes) || {};
      previousOwnerSid = existingAttrs.initiatingWorkerSid || null;
      if (
        context.SYNC_SERVICE_SID
        && previousOwnerSid
        && previousOwnerSid !== WorkerSid
      ) {
        try {
          const prev = await client.sync.v1
            .services(context.SYNC_SERVICE_SID)
            .syncMaps(`outbound-sends-${previousOwnerSid}`)
            .syncMapItems(ExistingConversationSid)
            .fetch();
          previousOwnerRowData = prev.data || {};
        } catch (e) {
          if (e.status !== 404) {
            console.warn('reopen-with-template: previous owner row fetch failed:', e.message);
          }
        }
      }

      // Build the deferred attribute update now so we can apply it after the
      // send succeeds. messages.create does not depend on these attributes.
      deferredOwnershipAttrs = {
        ...existingAttrs,
        sendMode: 'open-chat',
        initiatingWorkerSid: WorkerSid,
        initiatingWorkerName: workerName,
        lastReopenAt: new Date().toISOString(),
        lastReopenByWorkerSid: WorkerSid,
        taskCreated: false,
      };

      // Hand the existing conversation to the rest of the handler untouched.
      // The subsequent code reads existingAttrs via a re-fetch at line ~142;
      // the ownership-related attrs it reads are irrelevant to the send path.
      conversation = existing;
    } else {
      conversation = await client.conversations.v1.conversations.create({
        friendlyName: `Outbound WA to ${toE164} (open-chat)`,
        'timers.closed': autoCloseAfter,
        attributes: JSON.stringify({
          direction: 'outbound',
          channelType: context.CHANNEL_TYPE || 'whatsapp',
          customerAddress: toE164,
          initiatingWorkerSid: WorkerSid,
          initiatingWorkerName: workerName,
          sendMode: 'open-chat',
        }),
      });

      await client.conversations.v1
        .conversations(conversation.sid)
        .participants.create({
          'messagingBinding.address': customerAddress,
          'messagingBinding.proxyAddress': proxyAddress,
        });

      // Register a per-conversation webhook that ONLY fires for this conversation.
      const functionsBase = `https://${context.DOMAIN_NAME}`;
      await client.conversations.v1
        .conversations(conversation.sid)
        .webhooks.create({
          target: 'webhook',
          'configuration.url': `${functionsBase}/conversation-lifecycle`,
          'configuration.method': 'POST',
          'configuration.filters': ['onMessageAdded', 'onDeliveryUpdated', 'onConversationStateUpdated'],
        });
    }

    const message = await client.conversations.v1
      .conversations(conversation.sid)
      .messages.create({
        contentSid: ContentSid,
        contentVariables: ContentVariables || '{}',
        author: workerName,
      });

    // Message is on the wire now. Apply the deferred ownership transfer on
    // the conversation (reopen-with-template branch only). Doing this BEFORE
    // the send would leave the conversation pointing at the new owner while
    // the Sync row still lives with the old owner -- lifecycle updates would
    // then land in a non-existent row on the new owner's map and the
    // pre-webhook would reject every future free-text.
    let deferredOwnershipApplied = false;
    if (deferredOwnershipAttrs) {
      try {
        conversation = await client.conversations.v1
          .conversations(conversation.sid)
          .update({
            'timers.closed': autoCloseAfter,
            attributes: JSON.stringify(deferredOwnershipAttrs),
          });
        deferredOwnershipApplied = true;
      } catch (e) {
        // Message was sent; attribute update failed. Log and continue, but
        // DO NOT delete the previous owner's Sync row (gated below) --
        // otherwise the conversation keeps `initiatingWorkerSid: A` while
        // the row lives in B's map, which is the exact inconsistency the
        // deferred-update was supposed to prevent. Lifecycle events read
        // ownership from the conversation and would then write updates to
        // A's (empty) map; the pre-webhook would reject every future
        // free-text because A's row has no `lastReplyAt`.
        console.warn('send-outbound-template reopen attr update failed:', e.message);
      }
    }

    // Reuse existing Interaction+channel when reopening (we have one from a
    // previous send/park cycle). Otherwise create fresh and persist the SIDs
    // on the conversation so future unparks can reuse them via invites.create.
    const existingAttrs = safeJson(conversation.attributes) || {};
    const existingInteractionSid = existingAttrs.flexInteractionSid;
    const existingChannelSid = existingAttrs.flexInteractionChannelSid;

    // Invites API rejects worker_sid AND queue_sid. interaction.create
    // requires both. Reopen (invite path) targets the sender via KnownAgent
    // task attributes read by the workflow filter.
    const inviteAttrs = {
      direction: 'outbound',
      channelType: context.CHANNEL_TYPE || 'whatsapp',
      name: toE164,
      from: toE164,
      customerAddress: toE164,
      customerName: toE164,
      initiatingWorkerSid: WorkerSid,
      initiatingWorkerName: workerName,
      KnownAgentRoutingFlag: true,
      KnownAgentWorkerSid: WorkerSid,
    };
    const inviteRouting = {
      workspace_sid: context.TASKROUTER_WORKSPACE_SID,
      workflow_sid: context.TASKROUTER_WORKFLOW_SID,
      task_channel_unique_name: context.TASK_CHANNEL_NAME || 'chat',
      attributes: inviteAttrs,
    };

    let interaction;
    if (existingInteractionSid && existingChannelSid) {
      await client.flexApi.v1
        .interaction(existingInteractionSid)
        .channels(existingChannelSid)
        .invites.create({ routing: { properties: inviteRouting } });
      interaction = { sid: existingInteractionSid, channel: { sid: existingChannelSid } };
    } else {
      interaction = await client.flexApi.v1.interaction.create({
        channel: {
          type: context.CHANNEL_TYPE || 'whatsapp',
          initiated_by: 'agent',
          properties: { media_channel_sid: conversation.sid },
        },
        routing: {
          properties: {
            ...inviteRouting,
            worker_sid: WorkerSid,
            queue_sid: context.TASKROUTER_QUEUE_SID,
          },
        },
      });
      // Persist for future unpark/reopen cycles.
      await client.conversations.v1
        .conversations(conversation.sid)
        .update({
          attributes: JSON.stringify({
            ...existingAttrs,
            flexInteractionSid: interaction.sid,
            flexInteractionChannelSid: interaction.channel && interaction.channel.sid,
          }),
        });
    }

    const syncEntry = {
      conversationSid: conversation.sid,
      to: toE164,
      templateSid: ContentSid,
      templateName: TemplateName || null,
      mode: 'open-chat',
      sentAt: new Date().toISOString(),
      status: 'sent',
      initiatingWorkerSid: WorkerSid,
      initiatingWorkerName: workerName,
      lastMessageSid: message.sid,
    };
    // On reopen-with-template with ownership change, carry over historical
    // fields (lastReplyPreview, lastReplyAt, parkedBy*, etc.) from the
    // previous owner's row so the new owner sees the full history instead
    // of a brand-new "sent" row. The new fields (status, mode, sentAt,
    // owner) override the historical ones by spreading last.
    const mergedEntry = previousOwnerRowData
      ? { ...previousOwnerRowData, ...syncEntry }
      : syncEntry;
    const ownerWriteOk = await writeSyncEntry(client, context, WorkerSid, conversation.sid, mergedEntry);
    const teamWriteOk = await writeSyncEntry(client, context, 'team', conversation.sid, mergedEntry);

    // Delete the previous owner's row ONLY after BOTH writes above succeed.
    // writeSyncEntry swallows its errors and returns false; if we didn't
    // check the return we would delete A's row even when the write to B's
    // map failed, losing the conversation from every "Mine" view.
    // Also require the conversation attribute update (ownership transfer)
    // to have succeeded — otherwise the conversation still points at A
    // and deleting A's row would create the exact inconsistency the
    // deferred update was supposed to prevent.
    // A residual row on A's map after a successful transfer isn't cleaned
    // up by `/verify-active` (which only deletes rows whose conversation is
    // closed), but it's still an orphan: the conversation's own ownership
    // points at B, so lifecycle events update B's map and A's row ages out
    // only when the conversation itself closes.
    if (
      context.SYNC_SERVICE_SID
      && ownerWriteOk
      && teamWriteOk
      && deferredOwnershipApplied
      && previousOwnerSid
      && previousOwnerSid !== WorkerSid
    ) {
      try {
        await client.sync.v1
          .services(context.SYNC_SERVICE_SID)
          .syncMaps(`outbound-sends-${previousOwnerSid}`)
          .syncMapItems(conversation.sid)
          .remove();
      } catch (e) {
        if (e.status !== 404) console.warn('reopen-with-template: previous owner row cleanup failed:', e.message);
      }
    }

    response.setBody({
      conversationSid: conversation.sid,
      interactionSid: interaction.sid,
      messageSid: message.sid,
    });
    return callback(null, response);
  } catch (e) {
    console.error('send-outbound-template failed:', {
      message: e.message,
      code: e.code,
      status: e.status,
      moreInfo: e.moreInfo,
      details: e.details,
    });
    response.setStatusCode(500);
    response.setBody({ error: e.message, code: e.code });
    return callback(null, response);
  }
};

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return null; }
}

// Upsert an item in Sync Map `outbound-sends-<workerSid>`. Returns true on
// success, false if the write failed (including when SYNC_SERVICE_SID is
// unset). Callers can use the return value to decide whether to continue
// with downstream state changes (e.g. deleting an old owner's row only when
// the new owner's write actually landed).
async function writeSyncEntry(client, context, workerSid, conversationSid, data) {
  if (!context.SYNC_SERVICE_SID) return false;
  const mapName = `outbound-sends-${workerSid}`;
  try {
    try {
      await client.sync.v1
        .services(context.SYNC_SERVICE_SID)
        .syncMaps.create({ uniqueName: mapName });
    } catch (e) {
      if (e.code !== 54301 && !(e.status === 409)) throw e;
    }
    try {
      await client.sync.v1
        .services(context.SYNC_SERVICE_SID)
        .syncMaps(mapName)
        .syncMapItems.create({ key: conversationSid, data });
    } catch (e) {
      if (e.status === 409 || e.code === 54208) {
        // Item exists -> merge into existing data so we don't drop
        // lifecycle-managed fields like lastReplyAt/lastReplyPreview.
        const current = await client.sync.v1
          .services(context.SYNC_SERVICE_SID)
          .syncMaps(mapName)
          .syncMapItems(conversationSid)
          .fetch();
        await client.sync.v1
          .services(context.SYNC_SERVICE_SID)
          .syncMaps(mapName)
          .syncMapItems(conversationSid)
          .update({ data: { ...(current.data || {}), ...data } });
      } else {
        throw e;
      }
    }
    return true;
  } catch (e) {
    console.error('sync write failed:', e.message);
    return false;
  }
}
