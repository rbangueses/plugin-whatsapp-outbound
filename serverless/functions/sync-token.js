const TokenValidator = require('twilio-flex-token-validator').validator;

// Mint a short-lived Twilio Access Token with a Sync grant for the caller.
// The token identity = the agent's Flex identity, so Sync ACLs (if configured)
// treat each agent as themselves.
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

  const { AccessToken } = Twilio.jwt;
  const { SyncGrant } = AccessToken;

  const identity = (tokenResult && tokenResult.identity) || 'agent';
  const apiKey = context.TWILIO_API_KEY;
  const apiSecret = context.TWILIO_API_SECRET;
  if (!apiKey || !apiSecret) {
    response.setStatusCode(500);
    response.setBody({ error: 'TWILIO_API_KEY / TWILIO_API_SECRET not configured' });
    return callback(null, response);
  }

  const token = new AccessToken(context.ACCOUNT_SID, apiKey, apiSecret, {
    identity,
    ttl: Number(context.SYNC_TOKEN_TTL_SECONDS) || 3600,
  });
  token.addGrant(new SyncGrant({ serviceSid: context.SYNC_SERVICE_SID }));

  response.setBody({ token: token.toJwt(), identity });
  return callback(null, response);
};
