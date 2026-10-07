// Conversations service PRE-webhook (fires BEFORE a message is persisted).
//
// Enforces the WhatsApp 24-hour customer-service window: if an agent tries to
// send a free-text message to a WA customer who last replied >24h ago (or has
// never replied), the message is rejected before it reaches Meta. The agent
// then gets a toast from the plugin prompting them to send a template instead.
//
// IMPORTANT: this is a SERVICE-WIDE webhook. It fires on every outbound
// message across every conversation in the Flex Conversations service, AND
// on inbound customer messages. Conversations treats any 4xx/5xx from a
// pre-webhook as a hard reject of the message, so every early return here
// MUST be `allow()` for traffic the plugin doesn't own, otherwise we'd break
// unrelated channels (SMS/email) and inbound WhatsApp. All config/error
// checks happen only once we've determined this is a WhatsApp agent
// free-text send that the plugin should gate.

// Sentinel returned by readLastReplyAtFromSync to distinguish a legitimate
// "no inbound reply recorded yet" (row missing, 404) from a transient runtime
// failure (Sync 5xx, network, etc). The former should reject (policy); the
// latter should allow (don't block valid traffic on infra blips).
const RUNTIME_ERROR = Symbol('sync-runtime-error');

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  const eventType = event.EventType || event.event_type;
  const source = event.Source || event.source;

  // Fast paths: only gate agent-initiated free-text WA sends. Everything else
  // (templates, inbound, non-WA, system sources) passes through unexamined.
  if (eventType !== 'onMessageAdd') return allow(callback, response);
  if (source && !['SDK', 'API'].includes(source)) return allow(callback, response);
  if (event.ContentSid) return allow(callback, response);
  const conversationSid = event.ConversationSid || event.conversation_sid;
  if (!conversationSid) return allow(callback, response);

  try {
    const client = context.getTwilioClient();
    const conv = await client.conversations.v1.conversations(conversationSid).fetch();
    const attrs = safeJson(conv.attributes) || {};

    if (attrs.channelType !== 'whatsapp') return allow(callback, response);
    if (!attrs.initiatingWorkerSid) return allow(callback, response);

    // Inbound customer messages carry author=whatsapp:+E164 and must pass through.
    const author = event.Author || '';
    if (author.startsWith('whatsapp:')) return allow(callback, response);

    // Config check runs AFTER the fast paths. SYNC_SERVICE_SID is required
    // for the window check to be meaningful; a missing value means the
    // operator skipped a deploy step. We fail LOUD (500) so Twilio surfaces
    // the error -- but only for traffic that would otherwise go through the
    // Sync lookup. Non-WA, inbound, template, and non-plugin traffic has
    // already returned allow() above.
    if (!context.SYNC_SERVICE_SID) {
      console.error('wa-window-pre-webhook: SYNC_SERVICE_SID is not configured; blocking WA agent free-text send to surface the deploy issue.');
      response.setStatusCode(500);
      response.setBody({ error: 'wa_window_misconfigured', reason: 'SYNC_SERVICE_SID is required' });
      return callback(null, response);
    }

    const lastReplyAtResult = await readLastReplyAtFromSync(
      client,
      context,
      attrs.initiatingWorkerSid,
      conversationSid,
    );

    if (lastReplyAtResult === RUNTIME_ERROR) {
      // Transient Sync failure -- allow the send. We prefer to let WhatsApp
      // reject a genuinely out-of-window message than to block valid traffic
      // during an infra blip. Log so operators can monitor the rate.
      return allow(callback, response);
    }
    if (!lastReplyAtResult) return reject(callback, response, 'wa_window_closed_no_reply');

    const windowHours = Number(context.WA_WINDOW_HOURS) || 24;
    const ageMs = Date.now() - new Date(lastReplyAtResult).getTime();
    if (ageMs > windowHours * 60 * 60 * 1000) return reject(callback, response, 'wa_window_closed_expired');
    return allow(callback, response);
  } catch (e) {
    // Conversations API failure or similar outer error -- be permissive.
    // Config errors are explicitly handled above.
    console.error('wa-window-pre-webhook outer error, allowing send:', e.message);
    return allow(callback, response);
  }
};

function allow(callback, response) {
  response.setStatusCode(200);
  response.setBody({ ok: true });
  return callback(null, response);
}

function reject(callback, response, reason) {
  response.setStatusCode(403);
  response.setBody({ error: 'wa_window_closed', reason });
  return callback(null, response);
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return null; }
}

async function readLastReplyAtFromSync(client, context, workerSid, conversationSid) {
  const mapName = `outbound-sends-${workerSid}`;
  try {
    const item = await client.sync.v1
      .services(context.SYNC_SERVICE_SID)
      .syncMaps(mapName)
      .syncMapItems(conversationSid)
      .fetch();
    return (item.data || {}).lastReplyAt || null;
  } catch (e) {
    // Distinguish genuine not-found (row/map missing -> "no reply yet") from
    // transient errors (5xx, network, auth) which should allow the send.
    // Sync error codes: 20404 = HTTP not found; 54201 = Map Item not found.
    if (e.status === 404 || e.code === 20404 || e.code === 54201) {
      return null;
    }
    console.error('wa-window-pre-webhook sync fetch failed, allowing send:', e.message);
    return RUNTIME_ERROR;
  }
}
