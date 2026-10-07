const TokenValidator = require('twilio-flex-token-validator').validator;

function extractVariables(body) {
  const found = new Set();
  const re = /\{\{\s*(\w+)\s*\}\}/g;
  let m;
  while ((m = re.exec(body || '')) !== null) found.add(m[1]);
  return Array.from(found).map((key) => ({ key }));
}

function extractBody(types) {
  if (!types) return '';
  const t =
    types['twilio/text'] ||
    types['twilio/quick-reply'] ||
    types['twilio/list-picker'] ||
    types['twilio/card'] ||
    types['twilio/call-to-action'];
  return (t && t.body) || '';
}

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

  try {
    // v2/ContentAndApprovals returns each content bundled with its approval
    // status inline — one page = one call. Much cheaper than fetching approvals
    // one-by-one, and no silent catch to hide misses.
    const auth = Buffer.from(`${context.ACCOUNT_SID}:${context.AUTH_TOKEN}`).toString('base64');
    const url = 'https://content.twilio.com/v2/ContentAndApprovals?PageSize=100';

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ContentAndApprovals ${res.status}: ${text}`);
    }
    const data = await res.json();
    const contents = data.contents || [];

    // v2 ContentAndApprovals returns `approval_requests` flat (single WA approval),
    // NOT nested under `.whatsapp`. Filter on approval_requests.status === 'approved'.
    const templates = [];
    for (const c of contents) {
      const ar = c.approval_requests;
      if (!ar || ar.status !== 'approved') continue;

      // Twilio Verify auto-provisions a WA template per service; agents never
      // send these manually, so keep them out of the dropdown.
      const nameForFilter = (c.friendly_name || ar.name || '').toLowerCase();
      if (nameForFilter.startsWith('verify_auto_created')) continue;

      const body = extractBody(c.types);
      templates.push({
        sid: c.sid,
        friendlyName: c.friendly_name,
        language: c.language,
        body,
        variables: extractVariables(body),
      });
    }

    response.setBody({ templates, totalFetched: contents.length });
    return callback(null, response);
  } catch (e) {
    console.error('list-templates failed:', e);
    response.setStatusCode(500);
    response.setBody({ error: e.message });
    return callback(null, response);
  }
};
