import React, { useEffect, useMemo, useState } from 'react';
import * as Flex from '@twilio/flex-ui';

import { listTemplates, sendOutbound, SendMode, WhatsAppTemplate } from '../../utils/api';
import { renderPreview, isTemplateReady } from '../../utils/preview';
import { getPrefillTo } from '../../utils/activeTask';
import { getReopenContext, setReopenContext, subscribe as subscribeReopen, ReopenContext } from '../../utils/reopenContext';
import { pluginConfig } from '../../utils/pluginConfig';
import SendHistory from './SendHistory';
import * as s from './styles';

interface SendButtonsProps {
  reopenCtx: ReopenContext | null;
  canSend: boolean;
  sendingMode: SendMode | null;
  handleSend: (mode: SendMode) => void;
  buttonLabel: (mode: SendMode, base: string) => string;
}

// Order the three send buttons so pluginConfig.defaultSendMode sits first.
// In reopen-with-template mode only the open-chat button is shown regardless
// of the configured default (reopen inherently targets the clicker).
function renderSendButtons(p: SendButtonsProps) {
  const openChatBtn = (
    <button
      key="open-chat"
      onClick={() => p.handleSend('open-chat')}
      disabled={!p.canSend}
      style={s.primaryButton(!p.canSend)}
    >
      {p.buttonLabel('open-chat', p.reopenCtx ? 'Send template & reopen chat' : 'Send & open chat')}
    </button>
  );
  if (p.reopenCtx) return openChatBtn;

  const sameAgentBtn = (
    <button
      key="same-agent"
      onClick={() => p.handleSend('same-agent')}
      disabled={!p.canSend}
      style={s.primaryButton(!p.canSend)}
    >
      {p.buttonLabel('same-agent', 'Send — route reply to me')}
    </button>
  );
  const anyAgentBtn = (
    <button
      key="any-agent"
      onClick={() => p.handleSend('any-agent')}
      disabled={!p.canSend}
      style={s.primaryButton(!p.canSend)}
    >
      {p.buttonLabel('any-agent', 'Send — route reply to queue')}
    </button>
  );

  const order: Record<SendMode, React.ReactNode[]> = {
    'open-chat': [openChatBtn, sameAgentBtn, anyAgentBtn],
    'same-agent': [sameAgentBtn, openChatBtn, anyAgentBtn],
    'any-agent': [anyAgentBtn, openChatBtn, sameAgentBtn],
  };
  return order[pluginConfig.defaultSendMode];
}

const OutboundView: React.FC = () => {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templateSid, setTemplateSid] = useState<string>('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [to, setTo] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [sendingMode, setSendingMode] = useState<SendMode | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [reopenCtx, setReopenCtx] = useState<ReopenContext | null>(getReopenContext());

  useEffect(() => {
    // Honour any reopen context already set when the view mounts.
    const initial = getReopenContext();
    if (initial) {
      setReopenCtx(initial);
      setTo(initial.to);
    } else {
      setTo(getPrefillTo());
    }
    setLoading(true);
    listTemplates()
      .then((r) => setTemplates(r.templates))
      .catch((e) => setStatus({ tone: 'err', text: `Failed to load templates: ${e.message}` }))
      .finally(() => setLoading(false));

    // Subscribe to subsequent reopen requests while the view is live.
    const unsub = subscribeReopen((ctx) => {
      setReopenCtx(ctx);
      if (ctx) setTo(ctx.to);
    });
    return () => { unsub(); };
  }, []);

  const selected = useMemo(
    () => templates.find((t) => t.sid === templateSid) || null,
    [templates, templateSid],
  );

  useEffect(() => {
    if (!selected) {
      setValues({});
      return;
    }
    const seeded: Record<string, string> = {};
    selected.variables.forEach((v) => {
      seeded[v.key] = '';
    });
    setValues(seeded);
  }, [selected]);

  const rendered = selected ? renderPreview(selected, values) : '';
  const canSend = !!selected && !!to && isTemplateReady(selected, values) && sendingMode === null;

  const handleSend = async (mode: SendMode) => {
    if (!selected || !canSend) return;
    setSendingMode(mode);
    setStatus(null);
    try {
      const workerSid = Flex.Manager.getInstance().workerClient.sid;
      const res = await sendOutbound({
        to,
        contentSid: selected.sid,
        templateName: selected.friendlyName,
        contentVariables: values,
        workerSid,
        mode,
        existingConversationSid: reopenCtx ? reopenCtx.conversationSid : undefined,
      });
      // Reopen context is single-use; clear it as soon as a send fires.
      if (reopenCtx) setReopenContext(null);

      if (mode === 'open-chat') {
        setStatus({ tone: 'ok', text: `Sent. Conversation routed to you.` });
        Flex.Actions.invokeAction('NavigateToView', { viewName: 'agent-desktop' });
      } else if (mode === 'same-agent') {
        setStatus({ tone: 'ok', text: `Sent. If ${to} replies, the task will route to you.` });
      } else {
        setStatus({ tone: 'ok', text: `Sent. If ${to} replies, the task will route to any available agent.` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ tone: 'err', text: `Send failed: ${msg}` });
    } finally {
      setSendingMode(null);
    }
  };

  const buttonLabel = (mode: SendMode, base: string) =>
    sendingMode === mode ? 'Sending…' : base;

  return (
    <div style={s.container}>
      <div style={s.panel}>
        <h2 style={{ marginTop: 0 }}>Send a WhatsApp template</h2>

        {reopenCtx && (
          <div
            style={{
              background: '#fff8e1',
              border: '1px solid #ffe08a',
              padding: '10px 12px',
              borderRadius: 4,
              fontSize: 13,
              marginBottom: 16,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span>
              {reopenCtx.reason === 'window-closed'
                ? 'The 24-hour WhatsApp window has closed. Send a template to reopen this conversation.'
                : 'Customer has not replied yet. Send a template to re-engage.'}
              {' '}Conversation <code style={{ fontSize: 12 }}>{reopenCtx.conversationSid}</code> will be reused.
            </span>
            <button
              onClick={() => setReopenContext(null)}
              style={{ background: 'transparent', border: 0, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
              aria-label="Cancel reopen"
              title="Cancel reopen"
            >
              ×
            </button>
          </div>
        )}

        <div style={s.field}>
          <label htmlFor="to" style={s.label}>To (E.164 phone number)</label>
          <input
            id="to"
            type="tel"
            placeholder="+15551234567"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={s.input}
          />
        </div>

        <div style={s.field}>
          <label htmlFor="template" style={s.label}>Template</label>
          <select
            id="template"
            value={templateSid}
            onChange={(e) => setTemplateSid(e.target.value)}
            disabled={loading}
            style={s.input}
          >
            <option value="">{loading ? 'Loading templates…' : 'Select a template'}</option>
            {templates.map((t) => (
              <option key={t.sid} value={t.sid}>
                {t.friendlyName} ({t.language})
              </option>
            ))}
          </select>
        </div>

        {selected && selected.variables.length > 0 && (
          <div style={s.field}>
            <span style={s.label}>Variables</span>
            {selected.variables.map((v) => (
              <div key={v.key} style={{ marginBottom: 8 }}>
                <label htmlFor={`var-${v.key}`} style={{ ...s.label, fontWeight: 400 }}>
                  {`{{${v.key}}}`}
                  {v.example ? ` — e.g. ${v.example}` : ''}
                </label>
                <input
                  id={`var-${v.key}`}
                  value={values[v.key] || ''}
                  onChange={(e) => setValues({ ...values, [v.key]: e.target.value })}
                  style={s.input}
                />
              </div>
            ))}
          </div>
        )}

        {selected && (
          <div style={s.field}>
            <span style={s.label}>Preview</span>
            <div style={s.preview}>{rendered}</div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {renderSendButtons({ reopenCtx, canSend, sendingMode, handleSend, buttonLabel })}
        </div>

        {status && <div style={s.status(status.tone)}>{status.text}</div>}
      </div>

      <div style={{ marginTop: 16, maxWidth: 640 }}>
        <SendHistory />
      </div>
    </div>
  );
};

export default OutboundView;
