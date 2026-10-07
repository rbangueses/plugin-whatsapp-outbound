import React, { useEffect, useRef, useState } from 'react';
import * as Flex from '@twilio/flex-ui';

import { subscribeSendHistory, SendHistoryEntry, HistoryScope } from '../../utils/sync';
import { reopenConversation, verifyActive } from '../../utils/api';
import { setReopenContext } from '../../utils/reopenContext';
import { VIEW_NAME, showPluginError } from '../../WhatsAppOutboundPlugin';
import { pluginConfig } from '../../utils/pluginConfig';
import * as s from './styles';

const WA_WINDOW_MS = pluginConfig.waWindowHours * 60 * 60 * 1000;

// A conversation that has been parked by someone other than the original
// sender should display both so the agent sees provenance at a glance.
function renderOwnership(entry: SendHistoryEntry, currentWorkerSid: string, isMine: boolean) {
  const parker = entry.parkedByWorkerSid ? entry.parkedByWorkerName || 'unknown' : null;
  // When the current owner (initiatingWorkerSid) was set by a park, the
  // parkedBy* fields will match. If someone else parked after the original
  // sender, we show "parked by X, originally Y" when we can detect it.
  // Heuristic: if parkedByWorkerSid differs from the sendMode's original
  // owner, show both. We don't persist the "original sender" explicitly, so
  // in practice this triggers when a parker is different from the current
  // Sync-map owner -- which should never happen after a park (we transfer
  // ownership). So in current state this just shows a single name. Kept the
  // branch for clarity and future-proofing when we introduce explicit
  // "originalSender" tracking.
  if (parker && entry.parkedByWorkerSid !== entry.initiatingWorkerSid) {
    const parkerLabel = entry.parkedByWorkerSid === currentWorkerSid ? 'you' : parker;
    const originalLabel = entry.initiatingWorkerName || 'unknown';
    return (
      <span>
        parked by <span style={{ fontWeight: 600 }}>{parkerLabel}</span>
        {' · originally '}
        <span style={{ fontWeight: 400 }}>{originalLabel}</span>
      </span>
    );
  }
  if (parker) {
    const label = entry.parkedByWorkerSid === currentWorkerSid ? 'you' : parker;
    return <span>parked by <span style={{ fontWeight: isMine ? 400 : 600 }}>{label}</span></span>;
  }
  return (
    <span style={{ fontWeight: isMine ? 400 : 600 }}>
      {isMine ? 'you' : (entry.initiatingWorkerName || 'unknown')}
    </span>
  );
}

function needsTemplate(entry: SendHistoryEntry): { needs: boolean; reason: 'window-closed' | 'never-replied' | null } {
  if (!entry.lastReplyAt) return { needs: true, reason: 'never-replied' };
  const age = Date.now() - new Date(entry.lastReplyAt).getTime();
  if (age > WA_WINDOW_MS) return { needs: true, reason: 'window-closed' };
  return { needs: false, reason: null };
}

const STATUS_TONE: Record<SendHistoryEntry['status'], string> = {
  sent: '#5b6b7f',
  delivered: '#0263e0',
  read: '#1b5e20',
  replied: '#0f5132',
  failed: '#b71c1c',
  undelivered: '#b71c1c',
  parked: '#a45c00',
};

const MODE_LABEL: Record<SendHistoryEntry['mode'], string> = {
  'open-chat': 'Opened chat',
  'same-agent': 'Reply → initiator',
  'any-agent': 'Reply → queue',
};

const SendHistory: React.FC = () => {
  const [scope, setScope] = useState<HistoryScope>('mine');
  const [entries, setEntries] = useState<SendHistoryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reopeningSid, setReopeningSid] = useState<string | null>(null);
  const reconciledScopes = useRef<Set<HistoryScope>>(new Set());

  useEffect(() => {
    const workerSid = Flex.Manager.getInstance().workerClient.sid;
    let unsub: (() => void) | null = null;
    setEntries([]);
    setLoadError(null);
    subscribeSendHistory(workerSid, scope, (rows) => {
      setEntries(rows);
      if (!reconciledScopes.current.has(scope) && rows.length > 0) {
        reconciledScopes.current.add(scope);
        verifyActive(rows.map((r) => r.conversationSid), workerSid).catch((e) => {
          console.warn('verifyActive failed:', e);
        });
      }
    })
      .then((fn) => { unsub = fn; })
      .catch((e) => setLoadError(e.message));
    return () => { if (unsub) unsub(); };
  }, [scope]);

  const handleReopen = async (entry: SendHistoryEntry) => {
    setReopeningSid(entry.conversationSid);
    try {
      const workerSid = Flex.Manager.getInstance().workerClient.sid;
      await reopenConversation(entry.conversationSid, workerSid);
      Flex.Actions.invokeAction('NavigateToView', { viewName: 'agent-desktop' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showPluginError(`Reopen failed: ${msg}`);
    } finally {
      setReopeningSid(null);
    }
  };

  const handleReopenWithTemplate = (entry: SendHistoryEntry) => {
    const { reason } = needsTemplate(entry);
    setReopenContext({
      conversationSid: entry.conversationSid,
      to: entry.to,
      reason: reason || 'window-closed',
    });
    Flex.Actions.invokeAction('NavigateToView', { viewName: VIEW_NAME });
  };

  const sorted = [...entries].sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
  const currentWorkerSid = Flex.Manager.getInstance().workerClient.sid;

  return (
    <div style={s.panel}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Open conversations</h3>
        {pluginConfig.enableTeamView && (
        <div style={{ display: 'inline-flex', border: '1px solid #cbd2d9', borderRadius: 4, overflow: 'hidden' }}>
          <button
            onClick={() => setScope('mine')}
            style={{
              background: scope === 'mine' ? '#0263e0' : 'transparent',
              color: scope === 'mine' ? '#fff' : '#121c2d',
              border: 0,
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Mine
          </button>
          <button
            onClick={() => setScope('team')}
            style={{
              background: scope === 'team' ? '#0263e0' : 'transparent',
              color: scope === 'team' ? '#fff' : '#121c2d',
              border: 0,
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            All agents
          </button>
        </div>
        )}
      </div>

      {loadError && <div style={s.status('err')}>{loadError}</div>}
      {!loadError && sorted.length === 0 && (
        <div style={{ color: '#5b6b7f', fontSize: 13 }}>
          {scope === 'mine' ? 'No outbound sends yet.' : 'No open conversations across the team.'}
        </div>
      )}

      {sorted.map((entry) => {
        const when = new Date(entry.sentAt).toLocaleString();
        const isReopening = reopeningSid === entry.conversationSid;
        const isMine = entry.initiatingWorkerSid === currentWorkerSid;
        return (
          <div
            key={entry.conversationSid}
            style={{
              padding: '10px 0',
              borderBottom: '1px solid #eef1f4',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {entry.to}
                <span style={{ color: '#5b6b7f', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                  {entry.templateName || entry.templateSid}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#5b6b7f', marginTop: 2 }}>
                {when} · {MODE_LABEL[entry.mode] || entry.mode}
                {' · '}
                {renderOwnership(entry, currentWorkerSid, isMine)}
                {entry.lastReplyPreview && (
                  <>
                    {' · '}
                    <span style={{ fontStyle: 'italic' }}>“{entry.lastReplyPreview}”</span>
                  </>
                )}
              </div>
            </div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: STATUS_TONE[entry.status] || '#5b6b7f',
                textTransform: 'uppercase',
              }}
            >
              {entry.status}
            </div>
            {(() => {
              const { needs } = needsTemplate(entry);
              if (needs) {
                return (
                  <button
                    onClick={() => handleReopenWithTemplate(entry)}
                    style={{
                      background: 'transparent',
                      border: '1px solid #cbd2d9',
                      borderRadius: 4,
                      padding: '4px 10px',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    Reopen with template
                  </button>
                );
              }
              return (
                <button
                  onClick={() => handleReopen(entry)}
                  disabled={isReopening}
                  style={{
                    background: 'transparent',
                    border: '1px solid #cbd2d9',
                    borderRadius: 4,
                    padding: '4px 10px',
                    fontSize: 12,
                    cursor: isReopening ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isReopening ? 'Opening…' : 'Reopen'}
                </button>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
};

export default SendHistory;
