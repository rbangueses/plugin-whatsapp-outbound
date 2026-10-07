const TokenValidator = require('twilio-flex-token-validator').validator;

// Reopen an existing conversation into an Agent Desktop task.
// Verifies the conversation is still active (a closed conversation would spawn
// a NEW one and lose history) and then wraps it in a Flex Interaction routed
// to the caller.
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

  const { ConversationSid, WorkerSid } = event;
  if (!ConversationSid || !WorkerSid) {
    response.setStatusCode(400);
    response.setBody({ error: 'Missing ConversationSid or WorkerSid' });
    return callback(null, response);
  }

  const client = context.getTwilioClient();
  const workerName = (tokenResult && tokenResult.identity) || 'agent';

  try {
    const conversation = await client.conversations.v1
      .conversations(ConversationSid)
      .fetch();

    if (conversation.state === 'closed') {
      response.setStatusCode(409);
      response.setBody({
        error: 'Conversation is closed. Reopening would create a new conversation and lose history.',
        state: conversation.state,
      });
      return callback(null, response);
    }

    const attrs = safeJson(conversation.attributes) || {};
    const customerAddress = attrs.customerAddress || '';

    // Reuse the stored Interaction channel if we have one -- avoids 409
    // "A channel is already associated with this conversation". Reopen is
    // the same primitive as unpark: send an invite on the existing channel.
    const existingInteractionSid = attrs.flexInteractionSid;
    const existingChannelSid = attrs.flexInteractionChannelSid;

    // Invites API rejects worker_sid AND queue_sid; interaction.create needs both.
    const inviteAttrs = {
      direction: 'outbound-reopen',
      channelType: context.CHANNEL_TYPE || 'whatsapp',
      name: customerAddress,
      from: customerAddress,
      customerAddress,
      customerName: customerAddress,
      reopenedByWorkerSid: WorkerSid,
      reopenedByWorkerName: workerName,
      originalInitiatingWorkerName: attrs.initiatingWorkerName || null,
      // Target the clicking agent via the KnownAgent workflow filter.
      KnownAgentRoutingFlag: true,
      KnownAgentWorkerSid: WorkerSid,
    };
    const inviteRouting = {
      workspace_sid: context.TASKROUTER_WORKSPACE_SID,
      workflow_sid: context.TASKROUTER_WORKFLOW_SID,
      task_channel_unique_name: context.TASK_CHANNEL_NAME || 'chat',
      attributes: inviteAttrs,
    };

    if (existingInteractionSid && existingChannelSid) {
      await client.flexApi.v1
        .interaction(existingInteractionSid)
        .channels(existingChannelSid)
        .invites.create({ routing: { properties: inviteRouting } });
      response.setBody({ conversationSid: conversation.sid, interactionSid: existingInteractionSid, reused: true });
      return callback(null, response);
    }

    // No existing Interaction -- create one and persist its SIDs for future reuse.
    const interaction = await client.flexApi.v1.interaction.create({
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

    try {
      await client.conversations.v1
        .conversations(conversation.sid)
        .update({
          attributes: JSON.stringify({
            ...attrs,
            flexInteractionSid: interaction.sid,
            flexInteractionChannelSid: interaction.channel && interaction.channel.sid,
          }),
        });
    } catch (e) {
      console.warn('reopen: persistInteractionSids failed:', e.message);
    }

    response.setBody({
      conversationSid: conversation.sid,
      interactionSid: interaction.sid,
    });
    return callback(null, response);
  } catch (e) {
    console.error('reopen-conversation failed:', {
      message: e.message,
      code: e.code,
      status: e.status,
    });
    response.setStatusCode(500);
    response.setBody({ error: e.message, code: e.code });
    return callback(null, response);
  }
};

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return null; }
}
