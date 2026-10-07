# plugin-whatsapp-outbound

Twilio Flex 2.x plugin for agent-initiated WhatsApp outbound: pick an approved template, send to a customer, control how a reply is routed, park conversations, re-engage customers whose 24-hour window has closed, and track every open conversation per-agent or across the team.

Scope is deliberately single-WABA. Supporting documents: [`ARCHITECTURE.md`](ARCHITECTURE.md) (reference for maintainers), [`TESTPLAN.md`](TESTPLAN.md) (manual QA), [`flex-whatsapp-outbound-blueprint.html`](flex-whatsapp-outbound-blueprint.html) (styled single-pager).

## Feature overview

**Entry points.**
- **Side-nav tab** — `WhatsApp Outbound` item in the Flex sidebar; the primary composer, always available.
- **Voice task canvas tab** — a `WhatsApp` tab appears next to `Call | Info` while a voice task is **live** or in **wrap-up**. Lets an agent send a follow-up template during the call itself, or immediately after when the customer didn't pick up. "To" is pre-populated with the customer's number — correctly derived whether the call was inbound (from `caller` / `from`) or outbound-from-Flex (from `outbound_to`).

**Send flows (three modes), available from either entry point.**
- **Send & open chat** — creates a Flex Interaction on send, chat task lands on the sending agent immediately. The chat composer is still gated by the WhatsApp 24h window: free-text is blocked until the customer sends an inbound message. The agent can send additional templates in the interim.
- **Send — route reply to me** — no task on send. When the customer replies, the lifecycle webhook creates a task targeted at the sending agent via the `Known Agent Routing` workflow filter. The filter has no built-in fallback: if the sender is offline, the task sits in a pending state (no reservation is created until the targeted worker is Available) and is cleared by TaskRouter's own task timeout, not the conversation TTL. Add a fallback expression to the workflow if you need queue overflow.
- **Send — route reply to queue** — no task on send. On reply, a raw TaskRouter task is created with no worker reserved; it goes straight into the Everyone queue for any available agent.

**Park and reopen.**
- **Park (me)** and **Park (all)** buttons on the active task's canvas complete the Flex task but keep the Twilio conversation `active`. Agent picks reply-routing policy at park time.
- "Open conversations" panel in the plugin tab lists every active conversation the agent currently owns, plus a toggle to see the team's open conversations.
- Clicking **Reopen** on a row within the 24h window creates a new chat task on the clicker's desktop against the existing conversation (reused via `channels.invites.create` — history is preserved).
- Clicking **Reopen with template** on a row outside the window navigates to the composer with the customer address pre-populated and a banner explaining the 24h window has closed.

**24-hour window enforcement.**
- A Twilio Conversations service pre-webhook rejects free-text WA sends when the window is closed. The reject carries a `wa_window_closed` reason.
- Plugin-side listener wraps `flex.Notifications.showNotification`; any failed WA send surfaces a prompt — "Reply to me" / "Reply to queue" — that auto-parks the current task with the chosen mode and navigates to the composer in reopen-with-template mode.

**Tracking.**
- Each agent has a Sync Map `outbound-sends-<WorkerSid>`, keyed by conversation SID. A shared Sync Map `outbound-sends-team` mirrors every row for the "All agents" toggle.
- Lifecycle webhook keeps `status`, `lastReplyAt`, `lastReplyPreview`, and `interactionSid` current.
- Row disappears from the panel when the conversation closes (via `onConversationStateUpdated`). A `/verify-active` endpoint sweeps the agent's rows on panel mount to catch drift from missed webhooks.

**Retention.**
- Every conversation is created with `Timers.Closed = AUTO_CLOSE_AFTER` (default `P5D`). Twilio enforces a 10-minute minimum.
- Customer replies and agent sends reset the timer. Silence closes the conversation.

**Configurability.**
- Deployment knobs for the WA window hours, Sync token TTL, task channel name, side-nav label, team-view toggle, Park on/off, and default send mode. Full table in [`ARCHITECTURE.md` §Variables and configuration](ARCHITECTURE.md#variables-and-configuration).

## Repository layout

```
plugin-whatsapp-outbound/
├── src/                                   # React plugin (Flex UI 2.x)
│   ├── WhatsAppOutboundPlugin.tsx         # Entry; registers views, buttons, listener
│   ├── components/
│   │   ├── OutboundView/
│   │   │   ├── OutboundView.tsx           # Composer: template, variables, preview, send
│   │   │   ├── SendHistory.tsx            # "Open conversations" panel (mine / team)
│   │   │   └── styles.ts
│   │   ├── ParkButton.tsx                 # Park(me) / Park(all) task-canvas controls
│   │   └── windowClosedListener.tsx       # Intercepts WA send-fail toasts
│   └── utils/
│       ├── api.ts                         # Function callers
│       ├── pluginConfig.ts                # FLEX_APP_* env parsing
│       ├── reopenContext.ts               # Pub/sub for reopen-with-template handoff
│       ├── activeTask.ts                  # Pre-fill from the current task
│       ├── preview.ts                     # Template body + variable rendering
│       └── sync.ts                        # Sync JS SDK + types
└── serverless/
    └── functions/
        ├── list-templates.js              # Approved WhatsApp templates (Content API v2)
        ├── send-outbound-template.js      # Open-chat mode + reopen-with-template
        ├── send-outbound-notask.js        # Deferred-task modes (same-agent / any-agent)
        ├── reopen-conversation.js         # Reopen from history row
        ├── park-conversation.js           # Park (me) / Park (all)
        ├── verify-active.js               # Reconcile stale Sync rows on panel mount
        ├── sync-token.js                  # Mint Sync access tokens for the plugin
        ├── wa-window-pre-webhook.js       # Service pre-webhook; 24h window guard
        └── conversation-lifecycle.protected.js  # Per-conversation lifecycle webhook
```

## Setup

### 1. Clone and prerequisites

```bash
git clone https://github.com/rbangueses/plugin-whatsapp-outbound.git
cd plugin-whatsapp-outbound
```

You'll also need Node.js 18+ and the Twilio CLI with the Serverless and Flex plugins, logged in to the target account:

```bash
twilio plugins:install @twilio-labs/plugin-serverless
twilio plugins:install @twilio-labs/plugin-flex
twilio login            # or: twilio profiles:use <profile>
```

All commands below run from the repo root unless a step says otherwise.

### 2. Deploy the Functions

```bash
cd serverless
cp .env.example .env   # fill values (see table below)
npm install
twilio serverless:deploy
```

Note the deployed base URL — you'll need it for the plugin `.env`.

**Required env vars** (see `serverless/.env.example` for the full annotated template):

| Variable | Purpose |
|---|---|
| `ACCOUNT_SID` | Twilio account SID |
| `AUTH_TOKEN` | Validates Flex JWTs via `twilio-flex-token-validator` |
| `TWILIO_API_KEY` / `TWILIO_API_SECRET` | API key credentials used by `/sync-token` |
| `WHATSAPP_FROM` | E.164 sender number, no `whatsapp:` prefix |
| `TASKROUTER_WORKSPACE_SID` | Flex workspace |
| `TASKROUTER_WORKFLOW_SID` | Workflow containing the Known Agent Routing filter |
| `TASKROUTER_QUEUE_SID` | Default queue (Interactions API requires it) |
| `SYNC_SERVICE_SID` | Sync service for per-agent + team maps |
| `CHANNEL_TYPE` | Defaults to `whatsapp` |
| `TASK_CHANNEL_NAME` | Defaults to `chat` |
| `AUTO_CLOSE_AFTER` | ISO 8601 duration for `Timers.Closed`. Default `P5D`. Twilio minimum: `PT10M`. |
| `WA_WINDOW_HOURS` | Window the pre-webhook enforces. Default `24`. |
| `SYNC_TOKEN_TTL_SECONDS` | Lifetime of Sync access tokens. Default `3600`. |

**`SYNC_SERVICE_SID` is required.** Beyond the obvious consequence (every Sync write is skipped and the tracking panel stays empty), the pre-webhook returns HTTP 500 on WA agent free-text sends when it's unset. That means **every outbound free-text on a plugin-managed WhatsApp conversation gets rejected — even inside the 24h window** — until the variable is configured. Templates still work (the pre-webhook short-circuits on `ContentSid`); inbound customer messages, non-WA channels, and non-plugin conversations are unaffected because they return early before the config check.

### 3. Attach the pre-webhook to the Flex Conversations service

The 24-hour window guard is a **service-level** pre-webhook on the Flex Conversations service. One-shot setup:

```bash
curl -s -u "$ACCOUNT_SID:$AUTH_TOKEN" -X POST \
  "https://conversations.twilio.com/v1/Services/<FLEX_CONVERSATIONS_SERVICE_SID>/Configuration/Webhooks" \
  --data-urlencode "PreWebhookUrl=<SERVERLESS_BASE_URL>/wa-window-pre-webhook" \
  --data-urlencode "Filters=onMessageAdd" \
  --data-urlencode "Method=POST"
```

Replace `<FLEX_CONVERSATIONS_SERVICE_SID>` with the Flex-default Conversations service (`ISxxxx...`) and `<SERVERLESS_BASE_URL>` with the URL from step 2.

### 4. Add the Known Agent Routing filter to your workflow

The "Reply to me" mode and reopen flows rely on a filter at the **top** of your TaskRouter workflow:

```json
{
  "filter_friendly_name": "Known Agent Routing",
  "expression": "KnownAgentRoutingFlag == true",
  "targets": [
    {
      "queue": "<EVERYONE_QUEUE_SID>",
      "known_worker_sid": "task.KnownAgentWorkerSid",
      "expression": "task.KnownAgentWorkerSid != null"
    }
  ]
}
```

Baseline shape lives in `serverless/main-workflow-config.json`.

### 5. (Optional) Inbound Studio flow

For brand-new inbound WhatsApp messages (first-contact customers), you'll need a Studio flow + WhatsApp address configuration that routes the inbound into Flex. The plugin ships `serverless/whatsapp-inbound-flow.json` as a baseline — publish it in Studio and attach it to your WhatsApp sender's address config.

Replies to conversations the plugin has already opened do NOT need Studio: the lifecycle webhook creates the task directly.

### 6. Configure and run the plugin

```bash
cd ..                  # back to the repo root if you're still in serverless/
cp .env.example .env
# set FLEX_APP_FUNCTIONS_BASE_URL to the twil.io URL from step 2
# optionally tune FLEX_APP_* feature flags (see table)
npm install
twilio flex:plugins:start
```

**Plugin env vars** (see `.env.example` for full annotations):

| Variable | Default | Purpose |
|---|---|---|
| `FLEX_APP_FUNCTIONS_BASE_URL` | — | URL of the deployed serverless (required) |
| `FLEX_APP_SIDE_NAV_LABEL` | `WhatsApp Outbound` | Side-nav item label |
| `FLEX_APP_ENABLE_TEAM_VIEW` | `true` | Expose the Mine / All agents toggle |
| `FLEX_APP_ENABLE_PARK` | `true` | Expose Park (me) / Park (all) on task canvas |
| `FLEX_APP_DEFAULT_SEND_MODE` | `open-chat` | Which send-mode button is first |
| `FLEX_APP_WA_WINDOW_HOURS` | `24` | Must match serverless `WA_WINDOW_HOURS` |

### 7. Deploy

```bash
twilio flex:plugins:deploy --changelog "<changelog>"
twilio flex:plugins:release --plugin-version <version>
```

## Design & edge cases

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for flow walkthroughs, the full data model, every conversation attribute, known limitations, and a debugging guide. The short list of consequential design decisions is in the companion blueprint HTML.

## Reference

- Prior art: [twilio-professional-services/plugin-outbound-cbm](https://github.com/twilio-professional-services/plugin-outbound-cbm) — not treated as production-grade; used as reference for the `KnownAgent*` attribute names to preserve interop.
- Park/unpark pattern borrows the "close agent participant, not channel" primitive from [TwilioLatamEngHub/plugin-conversations-park-an-interaction](https://github.com/TwilioLatamEngHub/plugin-conversations-park-an-interaction).
