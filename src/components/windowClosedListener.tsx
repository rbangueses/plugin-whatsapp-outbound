import React from 'react';
import * as Flex from '@twilio/flex-ui';

import { parkConversation, ParkMode } from '../utils/api';
import { setReopenContext } from '../utils/reopenContext';
import { VIEW_NAME } from '../WhatsAppOutboundPlugin';

const NOTIFICATION_ID = 'WAWindowClosedPrompt';

// Listen for WA free-text send failures (produced by the service pre-webhook
// that enforces the 24-hour window) and surface a toast prompting the agent
// to send a template instead. Agent picks reply-routing policy on the toast.
export function installWindowClosedListener(flex: typeof Flex, manager: Flex.Manager): void {
  flex.Notifications.registerNotification({
    id: NOTIFICATION_ID,
    closeButton: true,
    content: 'The 24-hour WhatsApp window has closed. Send a template to reopen the conversation?',
    type: flex.NotificationType.warning,
    timeout: 0,
    actions: [
      <flex.NotificationBar.Action
        label="Reply to me"
        onClick={(_: unknown, notification: { id: string }) => {
          handleWindowClosed('same-agent');
          flex.Notifications.dismissNotificationById(notification.id);
        }}
      />,
      <flex.NotificationBar.Action
        label="Reply to queue"
        onClick={(_: unknown, notification: { id: string }) => {
          handleWindowClosed('any-agent');
          flex.Notifications.dismissNotificationById(notification.id);
        }}
      />,
    ],
  });

  // Flex's send-fail notification doesn't flow through the Redux store
  // subscription path reliably. The dependable hook is wrapping
  // `Notifications.showNotification` -- every toast Flex renders goes through
  // that call site, so we can observe each one and promote our window-closed
  // toast on top of a chat send-fail for a WA task.
  const notifications = flex.Notifications as unknown as {
    showNotification: (id: string, ctx?: unknown) => unknown;
  };
  const originalShow = notifications.showNotification.bind(notifications);
  let reentrancyGuard = false;
  notifications.showNotification = (id: string, ctx?: unknown) => {
    const result = originalShow(id, ctx);
    try {
      if (reentrancyGuard) return result;
      const idLower = String(id || '').toLowerCase();
      const looksLikeSendFail =
        (/send/i.test(idLower) && /fail|error|rejected|forbidden/i.test(idLower))
        || /chat.*error|chat.*fail/i.test(idLower)
        || /cantsendmessage|couldnotsend|messagesenderror/i.test(idLower);
      if (!looksLikeSendFail) return result;
      const task = getSelectedTask();
      const attrs = (task && task.attributes) || {};
      if (attrs.channelType === 'whatsapp') {
        reentrancyGuard = true;
        originalShow(NOTIFICATION_ID);
        reentrancyGuard = false;
      }
    } catch (e) {
      console.warn('[wa-plugin] showNotification wrap failed', e);
    }
    return result;
  };
}

function getSelectedTask(): Flex.ITask | null {
  try {
    const state = Flex.Manager.getInstance().store.getState().flex;
    const sid = state.view.selectedTaskSid;
    if (!sid) return null;
    return state.worker.tasks.get(sid) || null;
  } catch { return null; }
}

function handleWindowClosed(mode: ParkMode) {
  const manager = Flex.Manager.getInstance();
  const state = manager.store.getState().flex;
  const selectedTaskSid = state.view.selectedTaskSid;
  if (!selectedTaskSid) {
    Flex.Actions.invokeAction('NavigateToView', { viewName: VIEW_NAME });
    return;
  }
  const task = state.worker.tasks.get(selectedTaskSid);
  const attrs = (task && task.attributes) || {};
  const conversationSid = (attrs.conversationSid as string)
    || (attrs.channelSid as string)
    || (attrs.flexInteractionChannelSid as string);
  const to = (attrs.customerAddress as string) || (attrs.from as string) || '';

  if (!conversationSid || !task) {
    Flex.Actions.invokeAction('NavigateToView', { viewName: VIEW_NAME });
    return;
  }

  const workerSid = manager.workerClient.sid;
  parkConversation({
    taskSid: task.taskSid,
    conversationSid,
    workerSid,
    mode,
  })
    .catch((e) => console.warn('[wa-plugin] auto-park failed:', e))
    .finally(() => {
      setReopenContext({ conversationSid, to, reason: 'window-closed' });
      Flex.Actions.invokeAction('NavigateToView', { viewName: VIEW_NAME });
    });
}
