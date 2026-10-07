# plugin-whatsapp-outbound — Architecture reference

Companion to `README.md` (feature overview) and `TESTPLAN.md` (test scenarios). This document describes what the plugin does, how, and why — including the edge cases we discovered during build.

## Table of contents

1. [Capabilities overview](#capabilities-overview)
2. [Topology](#topology)
3. [Resources on the Twilio account](#resources-on-the-twilio-account)
4. [Variables and configuration](#variables-and-configuration)
5. [Flow walkthroughs](#flow-walkthroughs)
6. [Data model: Sync maps](#data-model-sync-maps)
7. [Conversation attribute contract](#conversation-attribute-contract)
8. [Known edge cases and how they're handled](#known-edge-cases-and-how-theyre-handled)
9. [Known limitations and open items](#known-limitations-and-open-items)
10. [Debugging guide](#debugging-guide)

---

## Capabilities overview

**Two entry points to the composer.**
- Side-nav tab (`WhatsApp Outbound`) — always available.
- Voice task canvas tab (`WhatsApp` next to `Call | Info`) — surfaces only while a voice task is `assigned` (live) or `wrapping`. Pre-fills the "To" field from the task: inbound voice reads from `caller`/`from`, outbound voice reads from `outbound_to`.

**Outbound template sends.** Agent picks an approved WhatsApp template, fills variables, sends. Three send modes:
- **Open-chat** — immediate chat task on sender's desktop.
- **Reply to me** (`same-agent`) — no task on send; if customer replies within the TTL, a task is routed back to the sender via `KnownAgent*` task attributes and workflow filter.
- **Reply to queue** (`any-agent`) — no task on send; if customer replies, a task hits the Everyone queue for any available agent.

**Open conversations panel.** Side-nav tab showing the agent's currently-active conversations (per-agent Sync Map), plus a toggle to show the team's view (shared Sync Map). Each row shows status (`sent / delivered / read / replied / parked / failed`), initiator name, last reply preview, and a Reopen or Reopen-with-template button.

**Reopen.** Opens a task on the clicker's desktop for an existing conversation. Reuses the Flex Interaction channel via `channels(sid).invites.create` — never spawns a new conversation, so history is preserved.

**Park (two modes).** Agent-driven "I'm done with this task but keep the conversation open." Removes the task; conversation stays `active`. Agent picks reply-routing policy at park time (`Park (me)` or `Park (all)`). Conversation's `Timers.Closed` is refreshed on park.

**24-hour window enforcement.** Service-level pre-webhook rejects agent free-text sends when the WhatsApp 24h window is closed. The plugin intercepts the resulting Flex notification and shows a toast prompting the agent to send a template instead. The toast exposes two actions — **Reply to me** and **Reply to queue** — each of which parks the current task with the chosen reply-routing mode, then navigates to the Outbound tab in reopen-with-template mode.

**Inbound-first conversation handling.** When an agent parks a Studio-created inbound conversation, the plugin backfills plugin attributes, attaches the lifecycle webhook, and inserts the row into Sync — so inbound chats behave like outbound ones from that point on.

**Self-healing reconciliation.** On panel mount, the plugin asks the server to verify each row's conversation is still `active`; closed rows are deleted. Protects against drift from missed webhooks.

---

## Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                           Flex (browser)                        │
│  ┌───────────────────┐    ┌─────────────────────────────────┐   │
│  │ WhatsApp          │    │ Agent Desktop task canvas       │   │
│  │ Outbound tab      │    │  ┌──────────────────────────┐   │   │
│  │  - Send form      │    │  │ Park(me) Park(all) End   │   │   │
│  │  - Open convs     │    │  └──────────────────────────┘   │   │
│  │    panel          │    │  windowClosedListener           │   │
│  └─────────┬─────────┘    └──────────────┬──────────────────┘   │
│            │                             │                      │
└────────────┼─────────────────────────────┼──────────────────────┘
             │                             │
             │ HTTPS (POST with the        │
             │  caller's Flex JWT)         │
             ▼                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Twilio Serverless (plugin-whatsapp-outbound-serverless)        │
│                                                                 │
│   /list-templates              /sync-token                      │
│   /send-outbound-template      /verify-active                   │
│   /send-outbound-notask        /park-conversation               │
│   /reopen-conversation         /conversation-lifecycle (protected) │
│   /wa-window-pre-webhook                                        │
└───────────────┬─────────────────────────────────────────────────┘
                │
                │ Twilio API
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Twilio services                                                │
│                                                                 │
│   Flex Conversations service (ISxxxx…)                          │
│     ├─ pre-webhook: /wa-window-pre-webhook (service-wide)       │
│     └─ per-conversation webhooks: /conversation-lifecycle       │
│                                                                 │
│   TaskRouter workspace (WSxxxx…)                                │
│     ├─ Main workflow (WWxxxx…) — includes "Known Agent Routing" │
│     │   filter targeting task.KnownAgentWorkerSid               │
│     └─ Default queue (WQxxxx…)                                  │
│                                                                 │
│   Content API — list approved WhatsApp templates (v2/           │
│     ContentAndApprovals endpoint)                               │
│                                                                 │
│   Sync service                                                  │
│     ├─ outbound-sends-<WorkerSid>  (per agent)                  │
│     └─ outbound-sends-team         (shared team view)           │
│                                                                 │
│   WhatsApp sender address config (whatsapp:<WA_FROM>)           │
│     - auto-creation points at "WhatsApp Inbound to Flex" Studio │
│       flow, which copies KnownAgent* attrs onto task attrs      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Resources on the Twilio account

The deployment binds to the following Twilio resource types. SIDs for a given install belong in `serverless/.env` (the real values are not committed to the repo); the table below is the SID pattern and the role each resource plays.

| Resource | SID prefix | Role |
|---|---|---|
| Flex Conversations service | `ISxxxx...` | Default Flex Conversations service. Pre-webhook is attached here. |
| TaskRouter workspace | `WSxxxx...` | Flex Task Assignment workspace |
| TaskRouter workflow | `WWxxxx...` | Must contain the Known Agent Routing filter targeting `task.KnownAgentWorkerSid` |
| TaskRouter queue | `WQxxxx...` | Default queue used in Interactions API `routing.properties.queue_sid` |
| Chat task channel | `TCxxxx...` | Default `chat` channel used for new WA tasks |
| Sync service | `ISxxxx...` | Separate from the Flex Conversations service; owns the per-agent + team maps |
| Studio flow (inbound) | `FWxxxx...` | Routes brand-new inbound WA conversations into Flex. Baseline shape in `serverless/whatsapp-inbound-flow.json` |
| WhatsApp address config | `IGxxxx...` | Binds `whatsapp:<WA_FROM>` → Studio flow for cold inbounds |
| Serverless deploy | `ZSxxxx...` + `ZExxxx...` | Hosts the Functions |
| API key for Sync tokens | `SKxxxx...` | Used only by `/sync-token`; secret lives in `serverless/.env` |

---

## Variables and configuration

Everything the plugin exposes or reads as a variable. Organised by where the variable lives (env file, template body, Twilio resource, in-memory). Full data-model tables for Sync and conversation attributes live in sections 6 and 7.

### Serverless environment (`serverless/.env`)

Server-side only; never bundled into the browser.

| Name | Purpose | Default | Notes |
|---|---|---|---|
| `ACCOUNT_SID` | Twilio account SID | — | Required |
| `AUTH_TOKEN` | Twilio auth token | — | Required for Flex token validation |
| `TWILIO_API_KEY` / `TWILIO_API_SECRET` | API key credentials used by `sync-token` to mint access tokens | — | Required |
| `WHATSAPP_FROM` | E.164 sender number, no `whatsapp:` prefix | — | Required |
| `TASKROUTER_WORKSPACE_SID` | TaskRouter workspace | — | Required |
| `TASKROUTER_WORKFLOW_SID` | Workflow for routing | — | Must contain the Known Agent Routing filter targeting `task.KnownAgentWorkerSid` |
| `TASKROUTER_QUEUE_SID` | Default queue; required because the Interactions API's `routing.properties` schema requires it | — | Required |
| `SYNC_SERVICE_SID` | Twilio Sync service | — | **Required.** If unset, every Sync write is a no-op (panel stays empty) AND the pre-webhook returns 500 on WA agent free-text sends, blocking them even inside the 24h window. Templates, inbound, and non-plugin / non-WA traffic still pass. |
| `CHANNEL_TYPE` | Task channel type attribute | `whatsapp` | Used in task attributes |
| `AUTO_CLOSE_AFTER` | ISO 8601 duration for `Timers.Closed` on new conversations and park refresh | `P5D` | See "Auto-close semantics" below |
| `WA_WINDOW_HOURS` | WhatsApp Customer Service Window threshold enforced by the pre-webhook | `24` | Change only if your messaging policy differs from Meta's standard CSW |
| `SYNC_TOKEN_TTL_SECONDS` | Lifetime of Sync access tokens minted for the plugin | `3600` | Short = better rotation; long = fewer token mints |
| `TASK_CHANNEL_NAME` | TaskRouter task channel used when creating chat tasks | `chat` | Change only if your workspace uses a custom chat channel |

### Plugin build-time environment (`plugin-whatsapp-outbound/.env`)

Baked into the browser bundle at build time.

| Name | Purpose |
|---|---|
| `FLEX_APP_FUNCTIONS_BASE_URL` | URL of the deployed serverless, e.g. `https://plugin-whatsapp-outbound-serverless-xxxx-dev.twil.io` |
| `FLEX_APP_SIDE_NAV_LABEL` | Label of the Flex side-nav item. Default `WhatsApp Outbound`. |
| `FLEX_APP_ENABLE_TEAM_VIEW` | `true` / `false` — expose the "All agents" toggle in the Open conversations panel. Default `true`. |
| `FLEX_APP_ENABLE_PARK` | `true` / `false` — expose Park (me) / Park (all) buttons on the task canvas. Default `true`. When `false`, Flex's native End button is left in place. |
| `FLEX_APP_DEFAULT_SEND_MODE` | `open-chat` / `same-agent` / `any-agent` — which send mode button sits first in the composer. Default `open-chat`. |
| `FLEX_APP_WA_WINDOW_HOURS` | WhatsApp Customer Service Window in hours — used by the UI to decide "Reopen" vs "Reopen with template". Default `24`. Must match the serverless `WA_WINDOW_HOURS` or UI and policy drift. |

### Hardcoded constants

| Where | What | Notes |
|---|---|---|
| `src/components/OutboundView/SendHistory.tsx` | `WA_WINDOW_MS` | Threshold for Reopen vs Reopen-with-template, derived from `pluginConfig.waWindowHours` (which reads `FLEX_APP_WA_WINDOW_HOURS`) |
| Workflow filter | `KnownAgentRoutingFlag == true` with target `known_worker_sid: task.KnownAgentWorkerSid` | Pattern name mirrors `plugin-outbound-cbm` for interop |

### Template variables (per-template, user-defined)

Templates themselves are defined and approved outside the plugin via the Twilio Content API. The plugin discovers them at runtime.

| Where | What |
|---|---|
| Template body | `{{1}}`, `{{2}}`, ... placeholder tokens the agent fills at send time |
| `list-templates` function | Regex-extracts placeholders → surfaces one input field per unique key |
| `OutboundView` preview | Live substitution of each `{{n}}` with the agent's input |
| `ContentVariables` request param | Stringified JSON map `{"1": "...", "2": "..."}` posted to `send-outbound-template` / `send-outbound-notask` |
| Twilio Content API | Receives `ContentVariables` and renders the final message body. Each Content SID is bound to one specific language — if you need multilingual templates, maintain separate Content SIDs per language and have the plugin pick the right one at send time |

Variable keys are **template-defined, not plugin-defined**: when a template author approves "Hi {{customer_name}}, your order {{order_id}} ships {{date}}", the plugin will render three input fields keyed `customer_name`, `order_id`, `date`.

### Runtime state (summary)

The three stores that hold conversation state and tracking data:

| Store | Keyed by | Full schema |
|---|---|---|
| Twilio Conversation attributes (JSON blob on `conversation.attributes`) | — (one per conversation) | [§7 Conversation attribute contract](#conversation-attribute-contract) |
| Sync Map `outbound-sends-<WorkerSid>` (per agent) | `conversationSid` | [§6 Data model: Sync maps](#data-model-sync-maps) |
| Sync Map `outbound-sends-team` (shared) | `conversationSid` | [§6 Data model: Sync maps](#data-model-sync-maps) |

Reopen context (plugin only, in-memory, pub/sub via `src/utils/reopenContext.ts`) carries `{ conversationSid, to, reason }` between `SendHistory` and `OutboundView` when the agent clicks Reopen-with-template. Cleared after one send.

### Auto-close semantics

**What it is.** `AUTO_CLOSE_AFTER` is the ISO 8601 duration passed as `Timers.Closed` on every conversation the plugin touches. Twilio moves the conversation to `state: closed` after that duration of **inactivity** (no inbound or outbound messages).

**When the timer resets:**
- Any customer inbound message
- Any agent outbound message
- Explicit refresh on `park-conversation` (we pass `'timers.closed': AUTO_CLOSE_AFTER` on every park)
- Explicit refresh on reopen-with-template path (same)

**Cascade on close.**
1. Twilio sets `state: closed`.
2. Our per-conversation lifecycle webhook receives `onConversationStateUpdated` with `StateAfter: 'closed'`.
3. Function deletes the Sync map item (mine + team) → row disappears from the Open conversations panel in real time.

**Limits.**
- Twilio enforces a **10-minute minimum** on `Timers.Closed` (per the Conversations API schema). Values below `PT10M` are rejected on `conversation.create` / `update`. There is no documented maximum.
- Values on the short end (e.g. `PT10M`, `PT1H`) are legal and useful for load tests but agents will resent frequent churn.
- Per the Conversations API limits docs, the hard caps that are documented are **1000 participants per conversation** and **1000 active or inactive conversations per Chat identity**. There is no publicly documented message-count cap per conversation.

**Direction of the task ↔ conversation close relationship (per Flex docs):**
- Completing a Flex task closes the conversation. The chain is: task → Complete → agent removed from conversation → conversation state set to `closed`.
- Closing the conversation directly (API, `Timers.Closed`, our lifecycle webhook) is **not documented** to cancel any open task against that conversation. If this ever happens in practice while a task is still assigned, the task will likely stay on the agent's desktop until they End it. Not something we have to actively prevent, but worth knowing when debugging an "orphan" task.
- Flex Interaction channels (`UO...`) are closed explicitly by the plugin on park via `participants(sid).update({ status: 'closed' })` — closing the channel directly would cascade to closing the conversation, which we don't want on park.

---

## Flow walkthroughs

### A. Mode A — Send & open chat

1. Plugin → `/send-outbound-template`
2. Function creates conversation (`direction: outbound`, `channelType: whatsapp`, `sendMode: open-chat`), participant, scoped lifecycle webhook, template message.
3. Function creates a Flex Interaction with `routing: { worker_sid: <sender>, queue_sid, workflow_sid }` → task created and reserved to the sender.
4. Function persists `flexInteractionSid` + `flexInteractionChannelSid` on conversation attributes for future reuse.
5. Function writes a Sync entry (mine + team) with `status: sent, mode: open-chat`.
6. Plugin navigates agent to Agent Desktop; chat canvas renders.
7. As Twilio delivery callbacks fire, lifecycle webhook patches Sync `status` to `delivered → read`.
8. Customer reply → lifecycle webhook flips Sync status to `replied`.

### B. Mode B — Send + reply routes to me (`same-agent`)

1. Plugin → `/send-outbound-notask` with `Mode=same-agent`.
2. Function creates conversation with `sendMode: same-agent, KnownAgentRoutingFlag: true, KnownAgentWorkerSid: <sender>`.
3. Scoped lifecycle webhook attached.
4. Template message sent. Sync entry written. **No task created.**
5. Customer reply hits lifecycle webhook (filter `onMessageAdded`).
6. Webhook detects `author.startsWith('whatsapp:')` and `sendMode === 'same-agent'` and `!taskCreated` → creates a Flex Interaction with the sender as `worker_sid` and `KnownAgent*` attrs on the task.
7. Workflow's "Known Agent Routing" filter matches → task reserved for the specific worker.
8. `taskCreated: true` is persisted on conversation attrs to make the operation idempotent against burst replies.

### C. Mode C — Send + reply routes to queue (`any-agent`)

Same as mode B, except:
- No `KnownAgent*` attrs are set.
- On reply, the lifecycle webhook creates a **raw TaskRouter task** (not an Interaction) with `conversationSid` + `channelSid` in attributes. The Flex Interactions API requires `worker_sid` which forces first-refusal — undesirable for "route to queue" — so we bypass it.
- Workflow's default filter routes to Everyone queue.

### D. Reopen (within 24h window)

1. Agent clicks **Reopen** on an open conversation row (row's `lastReplyAt` is within 24h).
2. Plugin → `/reopen-conversation` with `ConversationSid` + `WorkerSid`.
3. Function checks `conversation.state !== 'closed'` (409 if closed).
4. Function reads conversation attrs to find existing `flexInteractionSid` + `flexInteractionChannelSid`.
5. Function calls `channels.invites.create` with `KnownAgentRoutingFlag` + `KnownAgentWorkerSid: <clicker>` → task routed to clicker.
6. Agent navigates to Agent Desktop; the chat task appears.

### E. Reopen with template (outside 24h or never replied)

1. SendHistory row shows "Reopen with template" if `lastReplyAt` is missing or >24h old.
2. Click → plugin sets reopen context (`{ conversationSid, to, reason }`) in an in-memory pub/sub, navigates to Outbound tab.
3. Outbound tab reads context, pre-populates "To", shows yellow banner, hides the two notask-mode buttons.
4. Agent picks a template → plugin sends via `/send-outbound-template` with `ExistingConversationSid`.
5. Function detects existing conversation. If the acting agent differs from the current `initiatingWorkerSid`, the function captures the previous owner's Sync row and transfers ownership on the conversation attributes.
6. Function sends the template. If the conversation already has a Flex Interaction (`flexInteractionSid` on attrs) — the normal case after an open-chat or same-agent cycle — it re-attaches via `channels.invites.create`. If the conversation has only ever been "reply to queue" (raw task path, no Interaction wrapper) it falls through to `interaction.create` and persists the new SIDs. Either way, a task opens on the acting agent.
7. On success: historical Sync fields (`lastReplyPreview`, `lastReplyAt`, `parkedBy*`, etc.) are merged into the new owner's row AFTER the send, then the previous owner's row is removed. Order matters — a mid-send failure must not leave the conversation absent from every agent's "Mine" view.
8. Reopen context is cleared after one successful send.

### F. Park

1. Agent clicks **Park (me)** or **Park (all)** on the task canvas.
2. Plugin → `/park-conversation` with `TaskSid`, `ConversationSid`, `WorkerSid`, `Mode`.
3. Function reads task attrs for `flexInteractionSid` + `flexInteractionChannelSid`.
4. If present, closes the **agent participant** (`channels.participants(sid).update({ status: 'closed' })`). This completes the task without closing the channel or conversation. (Closing the channel would cascade to closing the conversation — that's the trap we had to work around.)
5. If no Interaction (raw TaskRouter task case), completes the task directly.
6. Checks conversation state: if closed, cleans up Sync and returns.
7. Backfills attrs for inbound-first conversations (`channelType`, `direction`, `customerAddress` via participant lookup, lifecycle webhook attachment).
8. Updates conversation attrs: `initiatingWorkerSid` moves to parker, `sendMode: <chosen mode>`, `taskCreated: false`, `lastParkedAt` set, `Timers.Closed` refreshed.
9. Writes/patches Sync entry with `status: parked`. If parker ≠ original owner, moves the row from the original owner's map to the parker's.
10. Row re-appears in Open conversations panel for the parker.

### G. Customer reply after park

1. Customer sends a message → scoped lifecycle webhook fires on `onMessageAdded`.
2. `author` starts with `whatsapp:` → `statusUpdate = 'replied'`.
3. `sendMode` is `same-agent` or `any-agent` AND `!taskCreated` → `createFlexInteraction` runs.
4. Reuses `flexInteractionSid` + `flexInteractionChannelSid` from conversation attrs via `channels.invites.create` → no new Interaction, no 409.
5. `taskCreated: true` persisted on attrs so duplicate messages don't spawn duplicate tasks.
6. Sync patched to `replied` + optional `lastReplyPreview`.

### H. Conversation close (End button, TTL, or explicit API)

1. Twilio sets conversation state to `closed`.
2. Lifecycle webhook fires `onConversationStateUpdated` with `StateAfter: 'closed'`.
3. Function deletes Sync items (mine + team) → row disappears from UI.

### I. 24-hour window enforcement

1. Agent types free-text and clicks Send in the chat canvas.
2. Flex calls Conversations API `POST /Messages`.
3. Service-wide pre-webhook `/wa-window-pre-webhook` fires on `onMessageAdd`.
4. Pre-webhook fast-paths: non-API/SDK source, template sends (ContentSid present), non-WA, no plugin owner, inbound customer messages (`author.startsWith('whatsapp:')`).
5. For gated requests, pre-webhook reads `lastReplyAt` from the sender's Sync map.
6. If missing or `now - lastReplyAt > 24h` → returns HTTP 403 `{"error": "wa_window_closed", "reason": ...}`.
7. Twilio surfaces this to the Flex SDK as a chat send-fail notification.
8. Plugin's `windowClosedListener` wraps `Notifications.showNotification` and intercepts any send-fail notification on a WA task.
9. Our window-closed toast fires with two actions: **Reply to me** and **Reply to queue**.
10. Click either action → the current task is parked using the chosen mode (same-agent or any-agent), reopen context is set (customer address + conversation SID + reason), and the plugin navigates to the Outbound tab in reopen-with-template mode.

---

## Data model: Sync maps

**Naming note.** The map names start with `outbound-sends-*` for historical reasons — the panel originally only stored outbound sends. Today it also holds inbound conversations that an agent has parked (see the Inbound-first flow). The map name is kept as-is to avoid orphaning items in production; the UI label is **Open conversations**, which is accurate.

### `outbound-sends-<WorkerSid>` (per-agent)

Keyed by `conversationSid`. Each item's `data`:

| Field | Set by | Notes |
|---|---|---|
| `conversationSid` | send fn | Primary key echoed into the body |
| `to` | send fn; lifecycle (seed-only on 404 upsert, from `conversation.attributes.customerAddress`) | E.164, no `whatsapp:` prefix |
| `templateSid` | send fn | Content API SID |
| `templateName` | send fn | Friendly name |
| `mode` | send fn / park; lifecycle (seed-only on 404 upsert, from `conversation.attributes.sendMode`) | `open-chat` / `same-agent` / `any-agent` |
| `sentAt` | send fns; park (inbound-first path only — seeds a value when no Sync row exists yet); `send-outbound-template` reopen-with-template path (overwrites with the moment of the new send); lifecycle (seed-only on 404 upsert, falls back to the conversation's `dateCreated`) | ISO 8601. Represents the timestamp of the most recent outbound action on the row |
| `status` | send fn + lifecycle | `sent / delivered / read / failed / undelivered / replied / parked` |
| `initiatingWorkerSid` | send fn / park / reopen-with-template; lifecycle (seed-only on 404 upsert) | Current owner. Changes on park or reopen-with-template if the acting agent isn't the current owner |
| `initiatingWorkerName` | send fn / park / reopen-with-template; lifecycle (seed-only on 404 upsert) | Human-readable |
| `lastMessageSid` | send fn | Twilio IM SID |
| `interactionSid` | lifecycle | Flex KD SID when the task was created via the Interactions API (open-chat and same-agent flows). For any-agent replies the lifecycle webhook uses raw `tasks.create` instead, so this field holds a TaskRouter `WT…` task SID — not a Flex Interaction SID. Subsequent any-agent replies on the same conversation stay on the raw-task path and continue to update this field with new `WT…` SIDs; a `KD…` only ever appears if the conversation goes through an open-chat or same-agent flow at some point. |
| `lastReplyAt` | lifecycle (`onMessageAdded`) | ISO 8601 of customer's last inbound |
| `lastReplyPreview` | lifecycle | First 140 chars of inbound body |
| `lastStatusAt` | lifecycle | ISO 8601 of last status transition |
| `parkedAt` / `parkedByWorkerSid` / `parkedByWorkerName` | park | Only present after a park |

### `outbound-sends-team` (shared)

Same schema, every send and status update mirrors here. Used by the plugin's "All agents" toggle in Open conversations.

---

## Conversation attribute contract

Persisted on `conversation.attributes` and read by the lifecycle webhook, park, send functions, and pre-webhook.

| Field | Set by | Readers | Purpose |
|---|---|---|---|
| `direction` | send fns (`outbound`), park inbound backfill (`inbound`) | debug/audit | On the conversation this is only `outbound` or `inbound`. The `inbound-reply` and `outbound-reopen` values live on **task** attributes, not conversation attributes. |
| `channelType` | send fns / park inbound backfill | pre-webhook | Must be `whatsapp` for the plugin's pre-webhook gates to engage |
| `customerAddress` | send fns / park (inbound backfill via participants lookup) | reopen, task attributes | E.164 of the customer |
| `sendMode` | send fns / park | lifecycle | `open-chat` / `same-agent` / `any-agent` |
| `initiatingWorkerSid` | send fns / park (ownership transfer) / `send-outbound-template` reopen-with-template (ownership transfer) | lifecycle, pre-webhook, Sync map scoping | Current owner. Transferred to the acting agent on park AND on reopen-with-template if the acting agent differs from the previous owner |
| `initiatingWorkerName` | send fns / park / reopen-with-template (ownership transfer) | task attrs | Human name |
| `taskCreated` / `taskCreatedAt` | lifecycle webhook (sets `true` on first reply); park and reopen-with-template reset to `false` so a subsequent reply spawns a new task | lifecycle | Idempotency guard against duplicate task spawns on bursty replies |
| `interactionSid` | lifecycle webhook — rewritten each time it creates a task (so every unpark/reply spawn updates this) | debug/audit | SID of the task-generating primitive. For same-agent and open-chat flows this is a Flex Interaction (`KD…`); for any-agent it is a TaskRouter task (`WT…`) because that path doesn't go through the Interactions API |
| `flexInteractionSid` / `flexInteractionChannelSid` | `send-outbound-template`, `reopen-conversation`, `park-conversation` (preserves), lifecycle (persists on first creation) | reopen, lifecycle, park | Reused via `channels.invites.create` to avoid 409 on later invites. Only set when the conversation actually went through the Interactions API — any-agent-only conversations never have these |
| `KnownAgentRoutingFlag` / `KnownAgentWorkerSid` | `send-outbound-notask` (same-agent mode only); park removes them when mode flips to `any-agent` | — | Flags on the conversation so a future lifecycle run can read the intended mode. The actual routing read happens from **task attributes** set by the lifecycle/reopen/send-template invite payloads, not from the conversation. |
| `lastParkedAt` / `lastParkedByWorkerSid` / `lastParkedByWorkerName` | park | debug/audit | — |
| `lastReopenAt` / `lastReopenByWorkerSid` | `send-outbound-template` reopen-with-template path | debug/audit | Set when the existing-conversation branch runs |

---

## Known edge cases and how they're handled

### "Routing is invalid" from Interactions API

**Trigger:** calling `flexApi.v1.interaction.create` without `worker_sid`.
**Resolution:** always set `worker_sid` on `interaction.create`. For "any-agent" (no first-refusal), use raw `tasks.create` instead.

### Invites API rejects `worker_sid` and `queue_sid`

Opposite shape to `interaction.create`. The Invites API only accepts `workspace_sid`, `workflow_sid`, `task_channel_unique_name`, and `attributes`. Targeting a specific worker is done via `KnownAgentRoutingFlag` task attrs + workflow filter, not a direct `worker_sid` field.

### "A channel is already associated with this conversation" (409)

**Trigger:** calling `interaction.create` with `media_channel_sid` pointing at a conversation that already has an open Interaction channel.
**Resolution:** reuse the existing Interaction + channel via `channels.invites.create`. We persist `flexInteractionSid` + `flexInteractionChannelSid` on conversation attributes at first creation; subsequent reopens/replies look them up and reuse.

### Closing a Flex channel cascades to closing the conversation

**Trigger:** `flexApi.interaction(KD).channels(UO).update({ status: 'closed' })` when the channel was `initiated_by: 'customer'`.
**Resolution:** on park, close the **agent participant** instead of the channel (`channels.participants(sid).update({ status: 'closed' })`). This cascades to task completion but leaves the channel + conversation alive.

### Pre-webhook `source` field

**Trigger:** my first version only checked `source === 'API'`. Flex's chat canvas sends with `source === 'SDK'`.
**Resolution:** accept both `SDK` and `API`.

### Inbound-initiated conversations lack plugin attributes

**Trigger:** Studio-created conversations don't have `channelType`, `initiatingWorkerSid`, etc. Park function silently failed Sync patches because the row didn't exist.
**Resolution:** park detects inbound (`!attrs.initiatingWorkerSid`), derives `customerAddress` from the conversation's messaging binding participant, attaches the lifecycle webhook, backfills attrs. `patchSyncEntry` upserts (falls back to `writeSyncEntry` on 404).

### Twilio Conversations don't auto-close

Idle conversations stay `active` forever by default. There's no official per-conversation message cap, but accumulating unclosed conversations grows the account's active set unnecessarily — and inbound participants are bound to the 1000-conversation per-identity limit if the same WhatsApp address keeps opening new ones.
**Resolution:** `Timers.Closed = AUTO_CLOSE_AFTER` (default `P5D`) is set on every send and refreshed on park. 5 days of silence triggers an auto-close, which triggers `onConversationStateUpdated`, which deletes the Sync rows.

### Service-wide pre-webhook impacts every send across the Flex Conversations service

**Trigger:** attaching a pre-webhook with filter `onMessageAdd` means it fires on every outbound message across SMS, email, voice-transcripts, etc.
**Resolution:** function fast-paths non-WA, non-plugin-owned, inbound customer messages, and template sends in a few cheap conditionals before any Sync fetch.

### Flex surfaces send-fail as a notification but doesn't route it through the Redux store subscription I expected

**Trigger:** my first attempts (Redux store subscription, SDK monkey-patch, Flex action replace) all missed the error path.
**Resolution:** wrap `flex.Notifications.showNotification` directly. Every toast Flex surfaces goes through that method; we promote any send-fail toast on a WA task to our window-closed prompt.

### Toast prompts the agent even for reasons other than window-closed

**Trigger:** the matcher in `windowClosedListener` is permissive — it fires on *any* send-fail for a WA task.
**Rationale:** false positive (toast appears, agent dismisses) is less bad than silent failure. The toast itself is a question, not an action.

### Toast action navigates agent away from the current task

**Trigger:** auto-navigation is aggressive; could lose unsaved note context.
**Resolution:** two actions on the toast — "Reply to me" and "Reply to queue". Agent explicitly picks a reply-routing policy; dismissing the toast ("×") leaves everything untouched.

### Flex 2.x doesn't expose a stable "sortOrder" for the built-in End button

**Trigger:** we wanted Park next to End. `sortOrder: -1 ... 100` all put Park *after* End.
**Resolution:** remove Flex's built-in End button for WA tasks (`TaskCanvasHeader.Content.remove('actions', ...)`) and render our own End alongside Park inside a single component. End invokes `Flex.Actions.CompleteTask` so standard task-completion still fires.

### End closes the Twilio conversation permanently

**Trigger:** standard Flex chat-task completion closes the conversation.
**Resolution:** documented. Agents who want to resume later should Park, not End.

### Stale `KnownAgent*` flags after switching park mode

**Trigger:** park with `same-agent` sets `KnownAgentRoutingFlag`. Subsequent park with `any-agent` should clear them.
**Resolution:** park with `any-agent` explicitly deletes those two keys from updated attrs.

---

## Known limitations and open items

- **No message-level retry.** If any serverless entry point fails (the `conversation-lifecycle` webhook, the `wa-window-pre-webhook`, or any of the plugin-called Functions like `park-conversation` and `send-outbound-template`), there's no automatic retry. For a POC the manual recovery via logs is tolerated; for production add a DLQ pattern or similar.
- **Lifecycle webhook returns HTTP 200 on errors (no Twilio retry).** `conversation-lifecycle.protected.js` catches all exceptions and returns 200 so Twilio does NOT retry. A retry would re-run the whole handler (potentially spawning a second task) and the current idempotency guards aren't strong enough to make that safe. Trade-off: a failed lifecycle run is lost — the agent has to re-engage manually. Production hardening: add an outbox + idempotency key and flip the error path to return 500 so Twilio retries.
- **Pre-webhook adds latency.** ~100-300ms per outbound message across the entire Flex Conversations service, not just WA. Negligible at low volume; worth benchmarking at scale.
- **Sync scaling.** Sync Maps hit 1M items/map and 16KB/item limits, but far more importantly, there's no server-side query API. Searching "All agents" view with thousands of rows will become slow. Production path: add a database alongside Sync, keep Sync for real-time per-agent view.
- **No supervisor-only access control.** "All agents" view is open to every agent; privacy question at scale.
- **`lastReplyAt` is read from Sync, not Twilio.** Race condition at the 24h boundary: if a customer replies at 23:59:50 but the Sync update hasn't landed when the agent sends free-text at 23:59:55, the pre-webhook may wrongly reject. Documented as acceptable for POC.
- **Reopen task ownership is "whoever clicked."** Not configurable. Fine default; may need policy for shared ownership.
- **End button closes the conversation.** No way currently to "end this task but keep the conversation open" from within the chat UI — the agent has to Park. Could add a confirm dialog on End.
- **Pre-webhook error handling is three-way.** Transient Sync errors (5xx, network, auth) — allow the send; infra blips shouldn't block valid traffic. Missing `SYNC_SERVICE_SID` — block WA free-text with a 500 so a deploy issue surfaces immediately. Missing Sync row (404) — treat as "customer never replied" and reject. The 404 case is worth watching: Sync writes at send time are fire-and-forget, so a dropped write poisons the pre-webhook's lookup for that conversation forever. The lifecycle webhook mitigates this by upserting the row on 404 when it has a `patchSyncEntry` to apply, so the first delivery or reply event rehydrates the row.

---

## Debugging guide

### Common log check

```
twilio serverless:logs --environment=dev -o json | tail
```

All Functions log on error only; the happy path is intentionally silent to keep Serverless log volume manageable. Common error strings worth grepping: `conversation-lifecycle failed`, `park-conversation failed`, `send-outbound-template failed`, `wa-window-pre-webhook outer error`, `wa-window-pre-webhook sync fetch failed`, `wa-window-pre-webhook: SYNC_SERVICE_SID is not configured`.

### Inspecting a conversation's state

```
curl -s -u $SID:$TOKEN https://conversations.twilio.com/v1/Conversations/CH...
```

Key fields: `state`, `attributes` (JSON string), `timers.date_closed`.

### Inspecting webhooks on a conversation

```
curl -s -u $SID:$TOKEN https://conversations.twilio.com/v1/Conversations/CH.../Webhooks
```

Should include one entry pointing at `/conversation-lifecycle`. Flex-managed copilot and messaging orchestrator webhooks are also present and expected.

### Finding stuck/orphan Interaction channels

```
curl -s -u $SID:$TOKEN https://flex-api.twilio.com/v1/Interactions/KD.../Channels/UO...
```

If `status: active` on a conversation that should be reopened, close via `.update({ status: 'closed' })`.

### Sync map inspection

```
curl -s -u $SID:$TOKEN https://sync.twilio.com/v1/Services/<SYNC_SERVICE_SID>/Maps/outbound-sends-<WORKER_SID>/Items
```

Each item's `data` reflects the current state the plugin renders.

### Testing the pre-webhook without waiting 24h

Backdate the Sync entry's `lastReplyAt`:

```
# ISO 8601, 25h ago
OLD=$(node -e "console.log(new Date(Date.now()-25*3600*1000).toISOString())")
DATA=$(jq -c --arg t "$OLD" '.lastReplyAt=$t|.lastStatusAt=$t' <<< "$(curl -s -u $SID:$TOKEN "$MAP/Items/CH..." | jq .data)")
curl -s -u $SID:$TOKEN -X POST "$MAP/Items/CH..." --data-urlencode "Data=$DATA"
```

Then agent sends free-text → pre-webhook rejects → toast fires.

### Window-closed toast not firing

- The listener in `src/components/windowClosedListener.tsx` wraps `flex.Notifications.showNotification` and promotes any WA send-fail toast into the window-closed prompt. If no prompt appears when a free-text send fails:
  - Confirm the task has `channelType: 'whatsapp'` in attributes (inbound-first conversations only get this after a park).
  - Confirm the pre-webhook is attached: `GET /v1/Services/<FLEX_CONVERSATIONS_SERVICE_SID>/Configuration/Webhooks` and verify `pre_webhook_url` ends with `/wa-window-pre-webhook` and `filters` contains `onMessageAdd`. Serverless logs are not useful here — the function is silent on the happy path.
  - Confirm the message was actually blocked: the attempted send should NOT appear in the Programmable Messaging logs as an outbound to WhatsApp; the Conversations API should have returned a 4xx to the Flex SDK.
