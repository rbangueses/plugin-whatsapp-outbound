const TokenValidator = require('twilio-flex-token-validator').validator;

// Self-healing reconciliation: given a list of conversation SIDs, delete Sync
// rows for any that are already closed (or missing). Called by the plugin on
// mount so drift from missed onConversationStateUpdated webhooks is bounded.
exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  try {
    await TokenValidator(event.Token, context.ACCOUNT_SID, context.AUTH_TOKEN);
  } catch (e) {
    response.setStatusCode(401);
    response.setBody({ error: 'Invalid Flex token' });
    return callback(null, response);
  }

  const { WorkerSid, ConversationSids } = event;
  if (!WorkerSid || !ConversationSids) {
    response.setStatusCode(400);
    response.setBody({ error: 'Missing WorkerSid or ConversationSids' });
    return callback(null, response);
  }

  const sids = String(ConversationSids).split(',').map((s) => s.trim()).filter(Boolean);
  const client = context.getTwilioClient();
  const mapName = `outbound-sends-${WorkerSid}`;

  const removed = [];
  const kept = [];

  // Bound concurrency so we don't hammer the Conversations API with 100 parallel
  // fetches when an agent has a large history.
  const CONCURRENCY = 5;
  for (let i = 0; i < sids.length; i += CONCURRENCY) {
    const batch = sids.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (sid) => {
      let shouldDelete = false;
      try {
        const conv = await client.conversations.v1.conversations(sid).fetch();
        if (conv.state === 'closed') shouldDelete = true;
      } catch (e) {
        // 404 = conversation gone entirely. Clean up.
        if (e.status === 404) shouldDelete = true;
        else { console.error('verify-active fetch failed for', sid, e.message); return; }
      }

      if (!shouldDelete) { kept.push(sid); return; }

      await Promise.all([
        removeMapItem(client, context, mapName, sid),
        removeMapItem(client, context, 'outbound-sends-team', sid),
      ]);
      removed.push(sid);
    }));
  }

  response.setBody({ removed, kept, checked: sids.length });
  return callback(null, response);
};

async function removeMapItem(client, context, mapName, key) {
  try {
    await client.sync.v1
      .services(context.SYNC_SERVICE_SID)
      .syncMaps(mapName)
      .syncMapItems(key)
      .remove();
  } catch (e) {
    if (e.status !== 404) console.error('verify-active delete failed for', mapName, key, e.message);
  }
}
