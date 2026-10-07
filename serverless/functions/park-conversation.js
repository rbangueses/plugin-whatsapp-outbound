const TokenValidator = require('twilio-flex-token-validator').validator;

// Park: remove the agent from an active Interaction channel WITHOUT closing
// the channel or the conversation. Technique borrowed from Twilio LatAm
// Engineering's park-an-interaction plugin: close the agent participant via
//   client.flexApi.v1.interaction(KD).channels(UO).participants(PT).update({status:'closed'})
// This completes the task (participant close cascades to task completion),
// leaves the Interaction channel in `active` state, and does not touch the
// underlying Conversation. On a future reply, we unpark by posting an invite
// on the same channel -- no new Interaction, no 409 conflicts.
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

  const { TaskSid, ConversationSid, WorkerSid, Mode } = event;
  if (!TaskSid || !ConversationSid || !WorkerSid || !Mode) {
    response.setStatusCode(400);
    response.setBody({ error: 'Missing TaskSid, ConversationSid, WorkerSid, or Mode' });
    return callback(null, response);
  }
  if (Mode !== 'same-agent' && Mode !== 'any-agent') {
    response.setStatusCode(400);
    response.setBody({ error: `Invalid Mode: ${Mode}` });
    return callback(null, response);
  }

  const client = context.getTwilioClient();
  const workerName = (tokenResult && tokenResult.identity) || 'agent';

  try {
    // 1. Fetch the task to find the Interaction channel + the agent participant SID.
    let flexInteractionSid = null;
    let flexInteractionChannelSid = null;
    let agentParticipantSid = null;
    try {
      const taskNow = await client.taskrouter.v1
        .workspaces(context.TASKROUTER_WORKSPACE_SID)
        .tasks(TaskSid)
        .fetch();
      const taskAttrs = safeJson(taskNow.attributes) || {};
      flexInteractionSid = taskAttrs.flexInteractionSid || null;
      flexInteractionChannelSid = taskAttrs.flexInteractionChannelSid || null;
    } catch (e) {
      console.warn('park: task fetch failed:', e.message);
    }

    // 2. Close the agent participant. Cascades: Flex marks the task completed
    //    and removes the agent from the channel. Conversation stays active.
    if (flexInteractionSid && flexInteractionChannelSid) {
      try {
        const participants = await client.flexApi.v1
          .interaction(flexInteractionSid)
          .channels(flexInteractionChannelSid)
          .participants.list();
        // Match on routing_properties.worker_sid, which Flex sets when the
        // Interaction/invite created a reservation for a specific worker.
        const match = participants.find((p) => {
          const rp = p.routingProperties || {};
          return rp.worker_sid === WorkerSid || (p.type === 'agent' && !agentParticipantSid);
        });
        if (match) agentParticipantSid = match.sid;
      } catch (e) {
        console.warn('park: participant list failed:', e.message);
      }

      if (agentParticipantSid) {
        try {
          await client.flexApi.v1
            .interaction(flexInteractionSid)
            .channels(flexInteractionChannelSid)
            .participants(agentParticipantSid)
            .update({ status: 'closed' });
        } catch (e) {
          console.warn('park: participant close failed:', e.message);
        }
      } else {
        // No participant found -- fall back to completing the task directly.
        try {
          await client.taskrouter.v1
            .workspaces(context.TASKROUTER_WORKSPACE_SID)
            .tasks(TaskSid)
            .update({ assignmentStatus: 'completed', reason: 'parked by agent' });
        } catch (e) {
          if (e.status !== 404) console.warn('park: task update fallback failed:', e.message);
        }
      }
    } else {
      // Raw task (any-agent mode uses tasks.create without an Interaction).
      try {
        await client.taskrouter.v1
          .workspaces(context.TASKROUTER_WORKSPACE_SID)
          .tasks(TaskSid)
          .update({ assignmentStatus: 'completed', reason: 'parked by agent' });
      } catch (e) {
        if (e.status !== 404) console.warn('park: task update failed:', e.message);
      }
    }

    // 3. Update conversation attributes so the next reply routes correctly.
    //    If conversation is already closed for any reason, clean up Sync and return.
    const conv = await client.conversations.v1.conversations(ConversationSid).fetch();
    if (conv.state === 'closed') {
      const originalOwnerSid = (safeJson(conv.attributes) || {}).initiatingWorkerSid || WorkerSid;
      await deleteSyncEntry(client, context, originalOwnerSid, ConversationSid);
      await deleteSyncEntry(client, context, 'team', ConversationSid);
      response.setBody({ ok: true, conversationSid: ConversationSid, note: 'conversation already closed' });
      return callback(null, response);
    }
    const attrs = safeJson(conv.attributes) || {};

    // Detect inbound-first conversations (Studio flow created them; plugin
    // never touched them before). For those we need to:
    //   (a) backfill plugin-expected attrs so the lifecycle webhook recognises
    //       them,
    //   (b) attach our scoped lifecycle webhook so future replies produce
    //       tasks and status updates,
    //   (c) try to derive customerAddress from the conversation's messaging
    //       binding (participant address) so the row shows a meaningful "to".
    const isInbound = !attrs.initiatingWorkerSid;
    let derivedCustomerAddress = attrs.customerAddress || null;
    if (isInbound) {
      try {
        const participants = await client.conversations.v1
          .conversations(ConversationSid)
          .participants.list({ limit: 20 });
        const customer = participants.find((p) => p.messagingBinding && p.messagingBinding.address);
        if (customer && customer.messagingBinding.address) {
          derivedCustomerAddress = String(customer.messagingBinding.address).replace(/^whatsapp:/, '');
        }
      } catch (e) {
        console.warn('park: inbound participant lookup failed:', e.message);
      }

      // Attach the scoped lifecycle webhook if not already present.
      try {
        const existingWebhooks = await client.conversations.v1
          .conversations(ConversationSid)
          .webhooks.list({ limit: 20 });
        const alreadyAttached = existingWebhooks.some((w) =>
          (w.configuration && w.configuration.url || '').includes('conversation-lifecycle'),
        );
        if (!alreadyAttached) {
          const functionsBase = `https://${context.DOMAIN_NAME}`;
          await client.conversations.v1
            .conversations(ConversationSid)
            .webhooks.create({
              target: 'webhook',
              'configuration.url': `${functionsBase}/conversation-lifecycle`,
              'configuration.method': 'POST',
              'configuration.filters': ['onMessageAdded', 'onDeliveryUpdated', 'onConversationStateUpdated'],
            });
        }
      } catch (e) {
        console.warn('park: inbound webhook attach failed:', e.message);
      }
    }

    const updatedAttrs = {
      ...attrs,
      channelType: attrs.channelType || context.CHANNEL_TYPE || 'whatsapp',
      direction: attrs.direction || (isInbound ? 'inbound' : 'outbound'),
      customerAddress: derivedCustomerAddress || attrs.customerAddress || null,
      initiatingWorkerSid: WorkerSid,
      initiatingWorkerName: workerName,
      lastParkedAt: new Date().toISOString(),
      lastParkedByWorkerSid: WorkerSid,
      lastParkedByWorkerName: workerName,
      sendMode: Mode,
      taskCreated: false,
      flexInteractionSid: flexInteractionSid || attrs.flexInteractionSid || null,
      flexInteractionChannelSid: flexInteractionChannelSid || attrs.flexInteractionChannelSid || null,
    };
    // Clear KnownAgent flags from any previous same-agent cycle. If this park
    // is same-agent, the lifecycle webhook will re-set them on next reply.
    if (Mode === 'any-agent') {
      delete updatedAttrs.KnownAgentRoutingFlag;
      delete updatedAttrs.KnownAgentWorkerSid;
    }
    await client.conversations.v1
      .conversations(ConversationSid)
      .update({
        attributes: JSON.stringify(updatedAttrs),
        'timers.closed': context.AUTO_CLOSE_AFTER || 'P5D',
      });

    // 4. Patch Sync. Transfer owner if parker != original sender.
    const originalOwnerSid = attrs.initiatingWorkerSid || WorkerSid;
    const patch = {
      conversationSid: ConversationSid,
      status: 'parked',
      parkedAt: new Date().toISOString(),
      parkedByWorkerSid: WorkerSid,
      parkedByWorkerName: workerName,
      initiatingWorkerSid: WorkerSid,
      initiatingWorkerName: workerName,
      mode: Mode,
      // Backfill fields the row renderer expects. For outbound they already
      // exist on the Sync row; for inbound-first we derive them so the row
      // looks consistent. Deliberately DO NOT touch sentAt for regular parks
      // — the patch is merged into existing Sync data, so the row's existing
      // sentAt is preserved. For inbound-first parks (no Sync row yet) we
      // seed sentAt with "now" so the row renders a sensible timestamp.
      to: derivedCustomerAddress || attrs.customerAddress || null,
      ...(isInbound ? { sentAt: new Date().toISOString() } : {}),
    };
    if (originalOwnerSid !== WorkerSid) {
      try {
        const existing = await client.sync.v1
          .services(context.SYNC_SERVICE_SID)
          .syncMaps(`outbound-sends-${originalOwnerSid}`)
          .syncMapItems(ConversationSid)
          .fetch();
        const merged = { ...(existing.data || {}), ...patch };
        await writeSyncEntry(client, context, WorkerSid, ConversationSid, merged);
        await deleteSyncEntry(client, context, originalOwnerSid, ConversationSid);
      } catch (e) {
        if (e.status === 404) {
          await writeSyncEntry(client, context, WorkerSid, ConversationSid, patch);
        } else {
          console.error('park: sync transfer failed:', e.message);
        }
      }
    } else {
      await patchSyncEntry(client, context, WorkerSid, ConversationSid, patch);
    }
    await patchSyncEntry(client, context, 'team', ConversationSid, patch);

    response.setBody({ ok: true, conversationSid: ConversationSid });
    return callback(null, response);
  } catch (e) {
    console.error('park-conversation failed:', { message: e.message, code: e.code, status: e.status });
    response.setStatusCode(500);
    response.setBody({ error: e.message, code: e.code });
    return callback(null, response);
  }
};

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return null; }
}

async function writeSyncEntry(client, context, workerSid, conversationSid, data) {
  if (!context.SYNC_SERVICE_SID) return;
  const mapName = workerSid === 'team' ? 'outbound-sends-team' : `outbound-sends-${workerSid}`;
  try {
    try {
      await client.sync.v1
        .services(context.SYNC_SERVICE_SID)
        .syncMaps.create({ uniqueName: mapName });
    } catch (e) {
      if (e.code !== 54301 && e.status !== 409) throw e;
    }
    await client.sync.v1
      .services(context.SYNC_SERVICE_SID)
      .syncMaps(mapName)
      .syncMapItems.create({ key: conversationSid, data });
  } catch (e) {
    if (e.status === 409) {
      try {
        await client.sync.v1
          .services(context.SYNC_SERVICE_SID)
          .syncMaps(mapName)
          .syncMapItems(conversationSid)
          .update({ data });
      } catch (upd) {
        console.error('park sync write-upsert failed:', upd.message);
      }
    } else {
      console.error('park sync write failed:', e.message);
    }
  }
}

async function deleteSyncEntry(client, context, workerSid, conversationSid) {
  if (!context.SYNC_SERVICE_SID) return;
  const mapName = workerSid === 'team' ? 'outbound-sends-team' : `outbound-sends-${workerSid}`;
  try {
    await client.sync.v1
      .services(context.SYNC_SERVICE_SID)
      .syncMaps(mapName)
      .syncMapItems(conversationSid)
      .remove();
  } catch (e) {
    if (e.status !== 404) console.error('park sync delete failed:', e.message);
  }
}

async function patchSyncEntry(client, context, workerSid, conversationSid, patch) {
  if (!context.SYNC_SERVICE_SID) return;
  const mapName = workerSid === 'team' ? 'outbound-sends-team' : `outbound-sends-${workerSid}`;
  try {
    const current = await client.sync.v1
      .services(context.SYNC_SERVICE_SID)
      .syncMaps(mapName)
      .syncMapItems(conversationSid)
      .fetch();
    const merged = { ...(current.data || {}), ...patch };
    await client.sync.v1
      .services(context.SYNC_SERVICE_SID)
      .syncMaps(mapName)
      .syncMapItems(conversationSid)
      .update({ data: merged });
  } catch (e) {
    if (e.status === 404) {
      // Row doesn't exist yet (inbound conversation, first time plugin
      // touches it). Create it instead.
      await writeSyncEntry(client, context, workerSid, conversationSid, patch);
    } else {
      console.error('park sync patch failed:', e.message);
    }
  }
}
