const TokenValidator = require('twilio-flex-token-validator').validator;

// Send-without-task: options 2 (route reply to same agent) and 3 (route reply
// to queue). Creates the conversation, sends the template, sets KnownAgent*
// attributes when mode=same-agent so the inbound Studio flow can copy them
// onto task attributes for the workflow filter to match.
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

  const { To, ContentSid, ContentVariables, WorkerSid, Mode, TemplateName } = event;
  if (!To || !ContentSid || !WorkerSid || !Mode) {
    response.setStatusCode(400);
    response.setBody({ error: 'Missing required parameters: To, ContentSid, WorkerSid, Mode' });
    return callback(null, response);
  }
  if (Mode !== 'same-agent' && Mode !== 'any-agent') {
    response.setStatusCode(400);
    response.setBody({ error: `Invalid Mode: ${Mode}` });
    return callback(null, response);
  }

  const client = context.getTwilioClient();
  const toE164 = String(To).trim();
  const customerAddress = `whatsapp:${toE164}`;
  const proxyAddress = `whatsapp:${context.WHATSAPP_FROM}`;
  const workerName = (tokenResult && tokenResult.identity) || 'agent';
  const autoCloseAfter = context.AUTO_CLOSE_AFTER || 'P5D';
  const alreadyOpenMessage =
    'You already have a conversation open with this number. Check your open conversations.';

  try {
    // Conversations permits only one non-closed binding for a customer/proxy
    // address pair. Check before creating a conversation so a duplicate send
    // produces a useful response without leaving an empty conversation behind.
    const participantConversations = await client.conversations.v1
      .participantConversations.list({ address: customerAddress, limit: 100 });
    const existingConversation = participantConversations.find((item) => {
      if (item.conversationState === 'closed') return false;
      const binding = item.participantMessagingBinding || {};
      const existingProxy = binding.proxy_address || binding.proxyAddress;
      return String(existingProxy || '').toLowerCase() === proxyAddress.toLowerCase();
    });
    if (existingConversation) {
      response.setStatusCode(409);
      response.setBody({
        error: alreadyOpenMessage,
        code: 50416,
        conversationSid: existingConversation.conversationSid,
      });
      return callback(null, response);
    }

    const conversationAttrs = {
      direction: 'outbound',
      channelType: context.CHANNEL_TYPE || 'whatsapp',
      customerAddress: toE164,
      initiatingWorkerSid: WorkerSid,
      initiatingWorkerName: workerName,
      sendMode: Mode,
    };
    if (Mode === 'same-agent') {
      conversationAttrs.KnownAgentRoutingFlag = true;
      conversationAttrs.KnownAgentWorkerSid = WorkerSid;
    }

    const conversation = await client.conversations.v1.conversations.create({
      friendlyName: `Outbound WA to ${toE164} (${Mode})`,
      'timers.closed': autoCloseAfter,
      attributes: JSON.stringify(conversationAttrs),
    });

    await client.conversations.v1
      .conversations(conversation.sid)
      .participants.create({
        'messagingBinding.address': customerAddress,
        'messagingBinding.proxyAddress': proxyAddress,
      });

    const functionsBase = `https://${context.DOMAIN_NAME}`;
    await client.conversations.v1
      .conversations(conversation.sid)
      .webhooks.create({
        target: 'webhook',
        'configuration.url': `${functionsBase}/conversation-lifecycle`,
        'configuration.method': 'POST',
        'configuration.filters': ['onMessageAdded', 'onDeliveryUpdated', 'onConversationStateUpdated'],
      });

    const message = await client.conversations.v1
      .conversations(conversation.sid)
      .messages.create({
        contentSid: ContentSid,
        contentVariables: ContentVariables || '{}',
        author: workerName,
      });

    const syncEntry = {
      conversationSid: conversation.sid,
      to: toE164,
      templateSid: ContentSid,
      templateName: TemplateName || null,
      mode: Mode,
      sentAt: new Date().toISOString(),
      status: 'sent',
      initiatingWorkerSid: WorkerSid,
      initiatingWorkerName: workerName,
      lastMessageSid: message.sid,
    };
    await writeSyncEntry(client, context, WorkerSid, conversation.sid, syncEntry);
    await writeSyncEntry(client, context, 'team', conversation.sid, syncEntry);

    response.setBody({
      conversationSid: conversation.sid,
      messageSid: message.sid,
      mode: Mode,
    });
    return callback(null, response);
  } catch (e) {
    console.error('send-outbound-notask failed:', {
      message: e.message,
      code: e.code,
      status: e.status,
      moreInfo: e.moreInfo,
      details: e.details,
    });
    if (e.code === 50416) {
      response.setStatusCode(409);
      response.setBody({ error: alreadyOpenMessage, code: e.code });
    } else {
      response.setStatusCode(500);
      response.setBody({ error: e.message, code: e.code });
    }
    return callback(null, response);
  }
};

async function writeSyncEntry(client, context, workerSid, conversationSid, data) {
  if (!context.SYNC_SERVICE_SID) return;
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
  } catch (e) {
    console.error('sync write failed:', e.message);
  }
}
