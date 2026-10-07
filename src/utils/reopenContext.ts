// Tiny pub/sub for cross-component reopen-with-template handoff.
// SendHistory sets it when the agent clicks "Reopen with template";
// OutboundView consumes + clears it on mount or when subscription fires.

export interface ReopenContext {
  conversationSid: string;
  to: string;
  reason: 'window-closed' | 'never-replied';
}

type Listener = (ctx: ReopenContext | null) => void;

let current: ReopenContext | null = null;
const listeners = new Set<Listener>();

export function setReopenContext(ctx: ReopenContext | null) {
  current = ctx;
  listeners.forEach((l) => l(current));
}

export function getReopenContext(): ReopenContext | null {
  return current;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
