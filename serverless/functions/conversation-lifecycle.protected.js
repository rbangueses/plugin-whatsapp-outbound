// Per-conversation webhook attached at conversation creation time. Fires on:
//   - onMessageAdded             — inbound customer messages mark the Sync row
//                                  'replied' AND, for deferred-task modes, the
//                                  handler creates the Flex Interaction/task
//                                  on the first customer reply.
//   - onDeliveryUpdated          — outbound delivery lifecycle updates the
//                                  Sync row status (sent/delivered/read/failed).
//   - onConversationStateUpdated — when state transitions to 'closed' the
//                                  handler deletes the per-agent AND team
//                                  Sync rows so the Open conversations panel
//                                  stays consistent.
//
// Marked .protected.js so Twilio Serverless validates X-Twilio-Signature.
exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  const client = context.getTwilioClient();
  const eventType = event.EventType || event.event_type;
  const conversationSid = event.ConversationSid || event.conversation_sid;
  if (!eventType || !conversationSid) {
    response.setStatusCode(200);
    response.setBody({ ok: true, skipped: 'missing fields' });
    return callback(null, response);
  }

  try {
    const conversation = await client.conversations.v1
      .conversations(conversationSid)
      .fetch();
    const attrs = safeJson(conversation.attributes) || {};
    const workerSid = attrs.initiatingWorkerSid;
    if (!workerSid) {
      response.setStatusCode(200);
      response.setBody({ ok: true, skipped: 'no initiatingWorkerSid' });
      return callback(null, response);
    }

    let statusUpdate = null;
    let extra = {};
    let createdInteractionSid = null;

    if (eventType === 'onMessageAdded') {
      const author = event.Author || '';
      const isCustomerReply = author.startsWith('whatsapp:');

      if (isCustomerReply) {
        statusUpdate = 'replied';
        extra = {
          lastReplyAt: new Date().toISOString(),
          lastReplyPreview: (event.Body || '').slice(0, 140),
        };

        // If this send was a deferred-task mode and no task has been created
        // yet, create the Interaction NOW. This is the whole point of the
        // lifecycle webhook: turn a silent conversation into a live task
        // the moment the customer engages.
        const needsTask = (attrs.sendMode === 'same-agent' || attrs.sendMode === 'any-agent')
          && !attrs.taskCreated;

        if (needsTask) {
          const result = await createFlexInteraction(client, context, {
            conversationSid,
            attrs,
            workerSid,
          });
          createdInteractionSid = result.sid;
          // Persist the flag so a burst of replies doesn't spawn duplicate tasks.
          // IMPORTANT: merge the newly-created Interaction SIDs here. We previously
          // wrote them inside createFlexInteraction and then clobbered them by
          // writing back ...attrs (a snapshot that pre-dated the persist).
          await client.conversations.v1
            .conversations(conversationSid)
            .update({
              attributes: JSON.stringify({
                ...attrs,
                taskCreated: true,
                taskCreatedAt: new Date().toISOString(),
                interactionSid: createdInteractionSid,
                ...(result.flexInteractionSid
                  ? {
                      flexInteractionSid: result.flexInteractionSid,
                      flexInteractionChannelSid: result.flexInteractionChannelSid,
                    }
                  : {}),
              }),
            });
        }
      }
    } else if (eventType === 'onDeliveryUpdated') {
      const level = event.DeliveryStatus || event.delivery_status;
      if (['sent', 'delivered', 'read', 'failed', 'undelivered'].includes(level)) {
        statusUpdate = level;
      }
    } else if (eventType === 'onConversationStateUpdated') {
      const newState = event.StateAfter || event.state_after;
      if (newState === 'closed') {
        await deleteSyncEntry(client, context, workerSid, conversationSid);
        await deleteSyncEntry(client, context, 'team', conversationSid);
        response.setBody({ ok: true, deleted: true });
        return callback(null, response);
      }
    }

    if (statusUpdate) {
      const patch = {
        status: statusUpdate,
        lastStatusAt: new Date().toISOString(),
        ...extra,
        ...(createdInteractionSid ? { interactionSid: createdInteractionSid } : {}),
      };
      // Identity fields the SendHistory row needs to render ("to", mode,
      // owner) and that /verify-active uses as the lookup key. patchSyncEntry
      // merges this into the patch ONLY when the row has to be created on 404
      // (dropped send-time write, or a late event arriving after a cleanup).
      // When the row already exists, these fields stay as whatever the send
      // function wrote.
      const seed = {
        conversationSid,
        to: attrs.customerAddress || null,
        mode: attrs.sendMode || null,
        initiatingWorkerSid: workerSid,
        initiatingWorkerName: attrs.initiatingWorkerName || null,
        sentAt: conversation.dateCreated
          ? new Date(conversation.dateCreated).toISOString()
          : new Date().toISOString(),
      };
      await patchSyncEntry(client, context, workerSid, conversationSid, patch, seed);
      await patchSyncEntry(client, context, 'team', conversationSid, patch, seed);
    }

    response.setBody({ ok: true, statusUpdate, createdInteractionSid });
    return callback(null, response);
  } catch (e) {
    // Deliberately return 200 so Twilio does NOT retry this webhook.
    // A retry would re-run the whole handler (potentially creating a second
    // task) and we don't have idempotency guards strong enough to make that
    // safe. The trade-off is documented in ARCHITECTURE "Known limitations":
    // a failed lifecycle run is lost and the agent has to re-engage manually.
    // If you harden this for production, add an outbox + idempotency key and
    // flip the status to 500 so Twilio retries.
    console.error('conversation-lifecycle failed:', {
      message: e.message,
      code: e.code,
      status: e.status,
      moreInfo: e.moreInfo,
      details: JSON.stringify(e.details || {}),
    });
    response.setBody({ ok: false, error: e.message });
    return callback(null, response);
  }
};

async function createFlexInteraction(client, context, { conversationSid, attrs, workerSid }) {
  const baseAttributes = {
    direction: 'inbound-reply',
    channelType: context.CHANNEL_TYPE || 'whatsapp',
    name: attrs.customerAddress,
    from: attrs.customerAddress,
    customerAddress: attrs.customerAddress,
    customerName: attrs.customerAddress,
    initiatingWorkerSid: workerSid,
    initiatingWorkerName: attrs.initiatingWorkerName || null,
    sendMode: attrs.sendMode,
    conversationSid,
    channelSid: conversationSid,
  };

  // If a previous Interaction + channel already exist for this conversation
  // (e.g. this is an UNPARK after an earlier task), reuse them via
  // channels.invites.create. Avoids 409 "channel already associated" errors.
  const existingInteractionSid = attrs.flexInteractionSid;
  const existingChannelSid = attrs.flexInteractionChannelSid;

  // same-agent: Invites API rejects worker_sid AND queue_sid; targeting the
  // specific agent happens via the "Known Agent Routing" workflow filter
  // reading KnownAgentWorkerSid off task attributes. interaction.create still
  // needs worker_sid + queue_sid (its own API shape); we build two payloads.
  if (attrs.sendMode === 'same-agent') {
    const inviteRouting = {
      workspace_sid: context.TASKROUTER_WORKSPACE_SID,
      workflow_sid: context.TASKROUTER_WORKFLOW_SID,
      task_channel_unique_name: context.TASK_CHANNEL_NAME || 'chat',
      attributes: {
        ...baseAttributes,
        KnownAgentRoutingFlag: true,
        KnownAgentWorkerSid: workerSid,
      },
    };

    if (existingInteractionSid && existingChannelSid) {
      await client.flexApi.v1
        .interaction(existingInteractionSid)
        .channels(existingChannelSid)
        .invites.create({ routing: { properties: inviteRouting } });
      return { sid: existingInteractionSid };
    }

    const interaction = await client.flexApi.v1.interaction.create({
      channel: {
        type: context.CHANNEL_TYPE || 'whatsapp',
        initiated_by: 'customer',
        properties: { media_channel_sid: conversationSid },
      },
      routing: {
        properties: {
          ...inviteRouting,
          worker_sid: workerSid,
          queue_sid: context.TASKROUTER_QUEUE_SID,
        },
      },
    });
    // Return the new Interaction SIDs so the caller can merge them into the
    // conversation attributes write in ONE operation (previously we persisted
    // here, then the caller wrote back ...attrs and clobbered them).
    return {
      sid: interaction.sid,
      flexInteractionSid: interaction.sid,
      flexInteractionChannelSid: interaction.channel && interaction.channel.sid,
    };
  }

  // any-agent: no worker_sid, let the workflow route via its default filter.
  // Invites API: omit queue_sid (rejected); interaction.create path: include it.
  const inviteRoutingNoWorker = {
    workspace_sid: context.TASKROUTER_WORKSPACE_SID,
    workflow_sid: context.TASKROUTER_WORKFLOW_SID,
    task_channel_unique_name: context.TASK_CHANNEL_NAME || 'chat',
    attributes: baseAttributes,
  };

  if (existingInteractionSid && existingChannelSid) {
    await client.flexApi.v1
      .interaction(existingInteractionSid)
      .channels(existingChannelSid)
      .invites.create({ routing: { properties: inviteRoutingNoWorker } });
    return { sid: existingInteractionSid };
  }

  // First-time any-agent reply: Flex Interactions API rejects
  // interaction.create with routing but no worker_sid ("Routing is invalid"),
  // so we fall back to raw taskrouter task creation with conversationSid in
  // attributes. Flex's chat canvas renders against those keys. Note: the
  // "sid" returned here is a TaskRouter task SID (WT...), not a Flex
  // Interaction SID. The caller persists it to Sync as interactionSid but
  // keeps conversation flexInteractionSid untouched (there isn't one).
  const task = await client.taskrouter.v1
    .workspaces(context.TASKROUTER_WORKSPACE_SID)
    .tasks.create({
      workflowSid: context.TASKROUTER_WORKFLOW_SID,
      taskChannel: context.TASK_CHANNEL_NAME || 'chat',
      attributes: JSON.stringify({
        ...baseAttributes,
        channelSid: conversationSid,
        conversationSid,
      }),
    });

  return { sid: task.sid };
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return null; }
}

async function deleteSyncEntry(client, context, workerSid, conversationSid) {
  if (!context.SYNC_SERVICE_SID) return;
  const mapName = `outbound-sends-${workerSid}`;
  try {
    await client.sync.v1
      .services(context.SYNC_SERVICE_SID)
      .syncMaps(mapName)
      .syncMapItems(conversationSid)
      .remove();
  } catch (e) {
    // 404 is fine — item never existed or already removed.
    if (e.status !== 404) console.error('sync delete failed:', e.message);
  }
}

async function patchSyncEntry(client, context, workerSid, conversationSid, patch, seed) {
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
    // Row doesn't exist (send-time Sync write failed, late event after a
    // cleanup, or a race). Upsert with the identity seed as a base so the
    // row renders correctly in the panel instead of showing blank "To" /
    // "Invalid Date" / unresolvable Reopen target. Without the seed the row
    // would only have {status, lastStatusAt, lastReplyAt} which breaks the
    // SendHistory renderer and defeats /verify-active's cleanup lookup.
    if (e.status === 404 || e.code === 20404 || e.code === 54201) {
      try {
        try {
          await client.sync.v1
            .services(context.SYNC_SERVICE_SID)
            .syncMaps.create({ uniqueName: mapName });
        } catch (mapErr) {
          if (mapErr.code !== 54301 && mapErr.status !== 409) throw mapErr;
        }
        const data = { ...(seed || {}), ...patch };
        await client.sync.v1
          .services(context.SYNC_SERVICE_SID)
          .syncMaps(mapName)
          .syncMapItems.create({ key: conversationSid, data });
      } catch (upsertErr) {
        if (upsertErr.status === 409 || upsertErr.code === 54208) {
          // Raced with another writer that just created the row; let the
          // next lifecycle event merge normally.
          return;
        }
        console.error('sync patch upsert failed:', upsertErr.message);
      }
    } else {
      console.error('sync patch failed:', e.message);
    }
  }
}
