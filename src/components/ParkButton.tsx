import React, { useState } from 'react';
import * as Flex from '@twilio/flex-ui';

import { parkConversation, ParkMode } from '../utils/api';
import { showPluginError } from '../WhatsAppOutboundPlugin';

interface Props {
  task?: Flex.ITask;
}

// Park: complete the Flex task without closing the Twilio conversation.
// Agent picks the reply-routing policy at park time:
//   - "Park (reply to me)"    -> same-agent semantics
//   - "Park (reply to queue)" -> any-agent semantics
// The chosen mode is written to conversation attrs; when the customer next
// replies, the lifecycle webhook spawns a task via the correct routing path.
const ParkButton: React.FC<Props> = ({ task }) => {
  const [pendingMode, setPendingMode] = useState<ParkMode | null>(null);

  const doPark = async (mode: ParkMode) => {
    if (!task) return;
    const attrs = task.attributes || {};
    const conversationSid =
      (attrs.conversationSid as string) ||
      (attrs.channelSid as string) ||
      (attrs.flexInteractionChannelSid as string);
    if (!conversationSid) {
      showPluginError('No conversation attached to this task; cannot park.');
      return;
    }
    setPendingMode(mode);
    try {
      const workerSid = Flex.Manager.getInstance().workerClient.sid;
      await parkConversation({
        taskSid: task.taskSid,
        conversationSid,
        workerSid,
        mode,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showPluginError(`Park failed: ${msg}`);
    } finally {
      setPendingMode(null);
    }
  };

  // Match the native End button: ~36px tall, snug padding, slightly bolder
  // font. Orange = pause/park semantic, distinct from End's destructive red.
  const buttonBase: React.CSSProperties = {
    color: '#ffffff',
    border: 0,
    borderRadius: 4,
    padding: '0 14px',
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1,
    cursor: pendingMode ? 'not-allowed' : 'pointer',
    height: 36,
    minWidth: 72,
    letterSpacing: 0.1,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };

  const idleOrange = '#f3851c';
  const pressedOrange = '#c56a0b';

  return (
    <div style={{ display: 'inline-flex', gap: 8, marginRight: 8, alignItems: 'center' }}>
      <button
        onClick={() => doPark('same-agent')}
        disabled={pendingMode !== null}
        style={{ ...buttonBase, background: pendingMode === 'same-agent' ? pressedOrange : idleOrange }}
        title="Park: complete task, route next reply back to me"
      >
        {pendingMode === 'same-agent' ? 'Parking…' : 'Park (me)'}
      </button>
      <button
        onClick={() => doPark('any-agent')}
        disabled={pendingMode !== null}
        style={{ ...buttonBase, background: pendingMode === 'any-agent' ? pressedOrange : idleOrange }}
        title="Park: complete task, route next reply to any available agent"
      >
        {pendingMode === 'any-agent' ? 'Parking…' : 'Park (all)'}
      </button>
      <button
        onClick={() => task && Flex.Actions.invokeAction('CompleteTask', { task })}
        disabled={pendingMode !== null || !task}
        style={{ ...buttonBase, background: '#d61f1f' }}
        title="End the task and close the conversation"
      >
        End
      </button>
    </div>
  );
};

export default ParkButton;
