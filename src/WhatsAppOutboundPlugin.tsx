import React from 'react';
import * as Flex from '@twilio/flex-ui';
import { FlexPlugin } from '@twilio/flex-plugin';

import OutboundView from './components/OutboundView/OutboundView';
import ParkButton from './components/ParkButton';
import { installWindowClosedListener } from './components/windowClosedListener';
import { pluginConfig } from './utils/pluginConfig';

const PLUGIN_NAME = 'WhatsAppOutboundPlugin';
export const VIEW_NAME = 'whatsapp-outbound';
export const PLUGIN_ERROR_NOTIFICATION_ID = 'WAPluginError';

export function showPluginError(message: string): void {
  const flex = (window as unknown as { Twilio?: { Flex: typeof Flex } }).Twilio?.Flex;
  const Notifications = (flex && flex.Notifications) || Flex.Notifications;
  Notifications.showNotification(PLUGIN_ERROR_NOTIFICATION_ID, { message });
}

export default class WhatsAppOutboundPlugin extends FlexPlugin {
  constructor() {
    super(PLUGIN_NAME);
  }

  async init(flex: typeof Flex, manager: Flex.Manager): Promise<void> {
    installWindowClosedListener(flex, manager);

    // Shared error-toast template used by Park and Reopen flows. Flex
    // substitutes {{message}} from the context passed into showNotification,
    // so a single registration covers every "something failed" case.
    flex.Notifications.registerNotification({
      id: PLUGIN_ERROR_NOTIFICATION_ID,
      closeButton: true,
      content: '{{message}}',
      type: flex.NotificationType.error,
      timeout: 6000,
    });

    flex.ViewCollection.Content.add(
      <flex.View name={VIEW_NAME} key={VIEW_NAME}>
        <OutboundView key="outbound-view" />
      </flex.View>,
    );

    // Park button next to End on WA chat tasks. The filter keeps it off voice,
    // SMS, email and anything else — only outbound WA conversations we created
    // (identified by channelType or a conversationSid attribute).
    // Sit the Park button on the right-hand button cluster, immediately before
    // the native End button. Flex 2.x places built-in actions on the right at
    // ascending sortOrder; a slightly-less-than-End sortOrder puts us just
    // ahead of it. The exact "before End" sort position isn't a stable public
    // API — if a Flex upgrade changes the order, nudge this value.
    // We want: [Park (me)] [Park (all)] [End].
    // Flex ignores sortOrder for repositioning its built-in End button, so we
    // hide End for WhatsApp tasks and render our own trio in the correct order.
    const isWhatsAppTask = (props: { task?: Flex.ITask }) => {
      const task = props.task;
      if (!task) return false;
      const attrs = task.attributes || {};
      return (attrs.channelType === 'whatsapp')
        && !!(attrs.conversationSid || attrs.channelSid || attrs.flexInteractionChannelSid);
    };

    if (pluginConfig.enablePark) {
      // Remove the built-in End button for WhatsApp tasks; we render our own
      // inside ParkButton so the three buttons sit in a controlled order.
      // "actions" is the content key Flex uses for the default end-task button.
      flex.TaskCanvasHeader.Content.remove('actions', { if: isWhatsAppTask });
      flex.TaskCanvasHeader.Content.add(
        <ParkButton key="whatsapp-park-button" />,
        { sortOrder: 100, align: 'end', if: isWhatsAppTask },
      );
    }
    // If Park is disabled, Flex's built-in End button stays untouched.

    // Voice tasks: expose a WhatsApp tab next to Call/Info so an agent can
    // send a template while on the call (sharing a link mid-conversation) or
    // during wrap-up (follow-up when the customer didn't pick up).
    // OutboundView already pulls the "to" from the active task via
    // getPrefillTo(), which reads `caller` for voice tasks.
    const isLiveVoiceOrWrap = (props: { task?: Flex.ITask }) => {
      const task = props.task;
      if (!task) return false;
      const attrs = task.attributes || {};
      const isVoice = task.taskChannelUniqueName === 'voice'
        || attrs.channelType === 'voice'
        || attrs.channelType === 'default';
      if (!isVoice) return false;
      // Flex task status strings: 'assigned' (live) and 'wrapping' are the
      // two we want. Reserved/pending/completed/canceled are excluded.
      const status = task.status || task.taskStatus;
      return status === 'assigned' || status === 'wrapping';
    };

    flex.TaskCanvasTabs.Content.add(
      <flex.Tab
        key="whatsapp-outbound-voice-tab"
        label="WhatsApp"
        uniqueName="whatsapp-outbound"
      >
        <OutboundView key="outbound-view-voice" />
      </flex.Tab>,
      { sortOrder: 50, if: isLiveVoiceOrWrap },
    );

    // Agent Desktop sits at sortOrder 1, Teams at 3. Slot between them.
    flex.SideNav.Content.add(
      <flex.SideLink
        key={`${VIEW_NAME}-side-link`}
        showLabel
        icon="Message"
        iconActive="MessageBold"
        onClick={() => flex.Actions.invokeAction('NavigateToView', { viewName: VIEW_NAME })}
      >
        {pluginConfig.sideNavLabel}
      </flex.SideLink>,
      { sortOrder: 2 },
    );
  }
}
