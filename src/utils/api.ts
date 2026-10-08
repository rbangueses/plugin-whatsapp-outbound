import * as Flex from '@twilio/flex-ui';

const FUNCTIONS_BASE = (process.env.FLEX_APP_FUNCTIONS_BASE_URL || '').replace(/\/$/, '');

async function callFunction<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const manager = Flex.Manager.getInstance();
  const token = manager.user.token;

  const res = await fetch(`${FUNCTIONS_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Token: token, ...(body as Record<string, string>) }),
  });

  let data: { error?: string } = {};
  try {
    data = await res.json();
  } catch (_) {
    // Preserve the status fallback below when a Function returns no JSON body.
  }
  if (!res.ok) throw new Error(data.error || `${path} failed: ${res.status}`);
  if ((data as { error?: string }).error) throw new Error((data as { error: string }).error);
  return data as T;
}

export interface TemplateVariable {
  key: string;
  example?: string;
}

export interface WhatsAppTemplate {
  sid: string;
  friendlyName: string;
  language: string;
  body: string;
  variables: TemplateVariable[];
}

export function listTemplates(): Promise<{ templates: WhatsAppTemplate[] }> {
  return callFunction<{ templates: WhatsAppTemplate[] }>('/list-templates');
}

export type SendMode = 'open-chat' | 'same-agent' | 'any-agent';

export interface SendOutboundPayload {
  to: string;
  contentSid: string;
  templateName?: string;
  contentVariables: Record<string, string>;
  workerSid: string;
  mode: SendMode;
  existingConversationSid?: string;
}

export type ParkMode = 'same-agent' | 'any-agent';

export function parkConversation(payload: {
  taskSid: string;
  conversationSid: string;
  workerSid: string;
  mode: ParkMode;
}) {
  return callFunction<{ ok: boolean }>('/park-conversation', {
    TaskSid: payload.taskSid,
    ConversationSid: payload.conversationSid,
    WorkerSid: payload.workerSid,
    Mode: payload.mode,
  });
}

export interface SendOutboundResult {
  conversationSid: string;
  messageSid: string;
  interactionSid?: string;
  mode?: string;
}

export function verifyActive(conversationSids: string[], workerSid: string) {
  if (conversationSids.length === 0) return Promise.resolve({ removed: [], kept: [], checked: 0 });
  return callFunction<{ removed: string[]; kept: string[]; checked: number }>('/verify-active', {
    WorkerSid: workerSid,
    ConversationSids: conversationSids.join(','),
  });
}

export function reopenConversation(conversationSid: string, workerSid: string) {
  return callFunction<{ conversationSid: string; interactionSid: string }>('/reopen-conversation', {
    ConversationSid: conversationSid,
    WorkerSid: workerSid,
  });
}

export function sendOutbound(payload: SendOutboundPayload): Promise<SendOutboundResult> {
  const base: Record<string, string> = {
    To: payload.to,
    ContentSid: payload.contentSid,
    ContentVariables: JSON.stringify(payload.contentVariables),
    WorkerSid: payload.workerSid,
  };
  if (payload.templateName) base.TemplateName = payload.templateName;
  if (payload.existingConversationSid) base.ExistingConversationSid = payload.existingConversationSid;
  if (payload.mode === 'open-chat') {
    return callFunction<SendOutboundResult>('/send-outbound-template', base);
  }
  return callFunction<SendOutboundResult>('/send-outbound-notask', {
    ...base,
    Mode: payload.mode,
  });
}
