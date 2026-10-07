import * as Flex from '@twilio/flex-ui';

// Pull a "to" number from the currently selected task so the composer
// pre-populates with the CUSTOMER's number (never the agent's / Twilio sender).
// Flex task attribute conventions:
//   Chat / WA tasks         -> customerAddress
//   Voice (inbound)         -> from = customer ANI; to = Twilio DID
//   Voice (outbound dialer) -> from = Twilio sender; outbound_to = customer
//   Voice (legacy / IVR)    -> caller = customer; called = Twilio DID
export function getPrefillTo(): string {
  const state = Flex.Manager.getInstance().store.getState();
  const flexState = state.flex;

  const selectedSid = flexState.view.selectedTaskSid;
  if (!selectedSid) return '';

  const task = flexState.worker.tasks.get(selectedSid);
  if (!task) return '';

  const attrs = (task.attributes || {}) as Record<string, unknown>;
  const direction = String(attrs.direction || '').toLowerCase();

  // Chat/WA conversations: customerAddress is authoritative.
  if (attrs.customerAddress) return normalizeE164(String(attrs.customerAddress));

  // Outbound voice: the agent dialed the customer; from = Twilio sender,
  // so prefer outbound_to / to for the customer.
  if (direction === 'outbound') {
    const outbound = attrs.outbound_to || attrs.to || attrs.called;
    if (outbound) return normalizeE164(String(outbound));
  }

  // Inbound voice (and anything else): customer is on `from` or `caller`.
  const inbound = attrs.caller || attrs.from;
  return normalizeE164(String(inbound || ''));
}

function normalizeE164(raw: string): string {
  if (!raw) return '';
  // Strip whatsapp:, client:, sip: prefixes; keep the E.164 tail.
  const stripped = raw.replace(/^(whatsapp:|client:|sip:)/i, '');
  return stripped.trim();
}
