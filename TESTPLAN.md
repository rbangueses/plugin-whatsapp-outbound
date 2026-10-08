# Test plan

Manual QA covering every feature currently in the repo. Companion to [`README.md`](README.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).

> **Placeholders used throughout:** `<CUSTOMER_NUMBER>` is a WhatsApp-enabled test phone you control. `<AGENT_A>` is the signed-in agent running the test; `<AGENT_B>` is a second agent you can bring online separately. `<WA_FROM>` is your `WHATSAPP_FROM` E.164 number.

## Pre-flight

- You're logged into Flex as `<AGENT_A>`, Available.
- `<CUSTOMER_NUMBER>` is reachable from your phone.
- Open Twilio Function logs in another tab (console → Functions → service → environment → logs) so failures surface fast.
- Have a devtools console open for the Flex browser tab when testing anything plugin-side.
- Confirm the pre-webhook is attached to the Flex Conversations service (filter `onMessageAdd` → `/wa-window-pre-webhook`).

Record a run date / tester at the top of each pass so retests are easy to compare.

---

## Part 1 — Side-nav composer

### 1.1 List templates

**Steps:** open the `WhatsApp Outbound` side-nav tab.

**Pass:** template dropdown populates. Each entry shows `friendlyName (language)`. Entries whose approval status isn't `approved` are absent.

### 1.2 Template with variables renders live preview

**Steps:** pick a template with `{{1}}`, `{{2}}`, ... placeholders. Fill one at a time.

**Pass:** preview panel substitutes each placeholder as the agent types. Send buttons stay disabled until every variable has a non-empty value AND "To" is populated.

### 1.3 Mode A — Send & open chat

**Steps:** enter `<CUSTOMER_NUMBER>`, pick a template, click **Send & open chat**.

**Pass:**
- Plugin navigates to Agent Desktop.
- A chat task appears, reserved for `<AGENT_A>`.
- Chat panel shows the template as the first message, authored by the agent's identity.
- `<CUSTOMER_NUMBER>` receives the WhatsApp template.
- "Open conversations" row shows `sent`; transitions `delivered → read` as delivery callbacks fire.
- The 24h window hasn't opened yet (no customer inbound). Nothing in the Flex UI prevents the agent from typing and clicking Send on a free-text message — the block is reactive, not proactive: the pre-webhook rejects the send, Flex shows "Could not send message", and the plugin's window-closed toast appears with Reply-to-me / Reply-to-queue actions. Clicking either parks this just-opened chat task with the chosen mode and navigates to the composer. Agent **can** send additional templates in the interim without triggering the block (the pre-webhook short-circuits on `ContentSid`).
- Customer replies: Flex chat panel receives the message in real time; the "Open conversations" row flips to `replied` with a preview.

**Failure diagnostics:** check Function logs for `send-outbound-template failed`; check task attributes for `channelType: whatsapp` and `conversationSid`.

### 1.4 Mode B — Send + reply to me

**Steps:** send with **Send — route reply to me**.

**Pass:**
- No task on send. Status toast confirms "task will route to you."
- Row shows `sent → delivered → read` as callbacks fire.
- Reply from phone. Within 1-2s a task appears specifically on `<AGENT_A>`'s desktop (not another agent's).
- Task attributes include `KnownAgentRoutingFlag: true`, `KnownAgentWorkerSid: <WK_A>`, `conversationSid`.
- Row flips to `replied` with preview.

**Edge case — agent offline:** before the reply, set `<AGENT_A>` to Offline. Reply from phone. The task is created and targets `<AGENT_A>` but no reservation is offered while they're Offline — the task stays pending in TaskRouter. Return `<AGENT_A>` to Available: a reservation is created and offered. If the agent never returns, the task is cleared by TaskRouter's own task timeout rather than the conversation TTL (those are independent timers).

### 1.5 Mode C — Send + reply to queue

**Steps:** send with **Send — route reply to queue**. Have `<AGENT_B>` Available too.

**Pass:**
- No task on send.
- Reply from phone → a task appears in the Everyone queue.
- The task is **not** pre-reserved to `<AGENT_A>` — TaskRouter offers it to Available agents according to the queue's normal rules.
- Task attributes include `channelSid`, `conversationSid`, `sendMode: any-agent`, **no** `KnownAgentRoutingFlag`.
- Whichever agent accepts, the chat panel renders the full history.

---

## Part 2 — Voice task canvas tab

### 2.1 Tab visibility

**Steps:**
1. Start a voice call (inbound or outbound-from-Flex).
2. On the task canvas you should see `Call | Info | WhatsApp`.
3. End the call. During the ~30-second wrap window `WhatsApp` tab stays visible.
4. Complete the wrap. Task disappears → tab disappears with it.

**Pass:** tab is visible only during `accepted` and `wrapping`.

### 2.2 Pre-fill is the customer, not the Twilio number

**Steps:** test both directions.

**Inbound voice:** customer calls your Twilio DID. Click `WhatsApp` tab.
**Pass:** "To" shows `<CUSTOMER_NUMBER>` (the inbound caller), not the Twilio DID.

**Outbound voice (Flex dialer):** dial `<CUSTOMER_NUMBER>`. Click `WhatsApp` tab.
**Pass:** "To" shows `<CUSTOMER_NUMBER>` (read from `outbound_to`), not `<WA_FROM>`.

### 2.3 Mid-call template send

**Steps:** on an active voice call, open `WhatsApp` tab, send a template with Mode A.

**Pass:** template delivered to the phone; a separate chat task opens on `<AGENT_A>` (voice task still active). Agent is now on two tasks.

### 2.4 Wrap-up template send

**Steps:** end the call; while in wrap-up click `WhatsApp` tab, send with Mode B.

**Pass:** send succeeds. On customer reply (post-wrap), the chat task is reserved for `<AGENT_A>`.

---

## Part 3 — Park (me) and Park (all)

### 3.1 Park (me)

**Steps:** accept a chat task (any mode). Click **Park (me)** next to End.

**Pass:**
- Task completes and vanishes from the agent's desktop.
- The conversation does **not** close (verify via the Conversations console or by replying from the phone).
- "Open conversations" row shows status `parked` and the Reopen button.
- Reply from phone → task is routed back to `<AGENT_A>` via Known Agent filter.

### 3.2 Park (all)

**Steps:** same as 3.1 but click **Park (all)**.

**Pass:**
- Row shows `parked`.
- Reply from phone → task goes to the Everyone queue, not pre-reserved to the parker. Any Available agent can accept.
- Task attributes carry `sendMode: any-agent`, no `KnownAgentRoutingFlag`.

### 3.3 Park ownership transfer

**Steps:** `<AGENT_B>` parks a conversation originally sent by `<AGENT_A>`.

**Pass:**
- Row disappears from `<AGENT_A>`'s "Mine" view.
- Row appears in `<AGENT_B>`'s "Mine" view.
- `initiatingWorkerSid` on the conversation now points to `<AGENT_B>`.
- Both agents see the row in "All agents" view with `parked by <AGENT_B>` metadata on the row.

### 3.4 Inbound-first park (Studio-created conversation)

**Steps:**
1. From the phone, DM `<WA_FROM>` fresh (no prior conversation). Studio flow creates a task; `<AGENT_A>` accepts.
2. Click **Park (me)**.

**Pass:**
- Row appears in `<AGENT_A>`'s "Open conversations" panel showing `<CUSTOMER_NUMBER>` as "To". (Address is derived from the conversation's participant on park.)
- Conversation attrs now include `channelType: whatsapp`, `initiatingWorkerSid: <WK_A>`, `sendMode: same-agent`.
- The lifecycle webhook is attached to the conversation.
- Reply from phone → task routed back to `<AGENT_A>`.

---

## Part 4 — Reopen & reopen-with-template

### 4.1 Reopen within 24h

**Steps:** click **Reopen** on a row where the customer replied in the last 24h.

**Pass:** a chat task appears on the clicker's desktop with the full conversation history. The underlying Twilio conversation is reused (same `conversationSid`); no new one is created.

### 4.2 Reopen-with-template — never replied

**Steps:** send a template with Mode B or C. Do not reply from the phone. Wait a few seconds, refresh the panel.

**Pass:** the row shows a **Reopen with template** button (not "Reopen"). Click → plugin navigates to the composer with:
- "To" pre-filled with `<CUSTOMER_NUMBER>`
- A yellow banner reading "Customer has not replied yet. Send a template to re-engage."
- Only `Send template & reopen chat` button visible (the two notask-mode buttons are hidden)

Click the button → template delivered into the **same** conversation; row's `status`, `mode`, `sentAt` update accordingly in the panel.

### 4.3 Reopen-with-template — window expired

**Steps:**
1. Pick an active conversation where the customer previously replied.
2. **Fake-out:** backdate the Sync entry's `lastReplyAt` to 25h ago (see Appendix A).
3. Refresh the panel. The row should now show **Reopen with template**.

**Pass:**
- Button appears for the right reason (banner text reads "The 24-hour WhatsApp window has closed").
- Send flow reuses the existing conversation.
- Post-send, the Sync row updates — this previously had a bug where the row would not refresh on reopen.

### 4.4 Reopen-with-template transfers ownership across agents

**Steps:**
1. `<AGENT_A>` sends a template. Backdate `lastReplyAt` so the row shows "Reopen with template" in the panel.
2. `<AGENT_B>` opens the "All agents" view and clicks **Reopen with template** on `<AGENT_A>`'s row.
3. `<AGENT_B>` picks a template and sends.

**Pass:**
- Row disappears from `<AGENT_A>`'s "Mine" view.
- Row appears in `<AGENT_B>`'s "Mine" view.
- Row still visible to both agents under "All agents".
- Conversation attributes: `initiatingWorkerSid` is now `<AGENT_B>`'s SID.
- Historical fields (`lastReplyPreview`, any prior `parkedBy*`) are preserved on the row in `<AGENT_B>`'s map — the row isn't a brand-new "sent" row.
- If the send fails mid-flow, `<AGENT_A>`'s row stays intact: ownership transfer only happens after the template actually sends. To simulate: temporarily swap the chosen template's `ContentSid` in the Content Template Builder for one that is unapproved for WhatsApp, or paste a bogus `HX…` into the browser devtools call to `/send-outbound-template`. The pre-webhook short-circuits on `ContentSid`, so disabling the pre-webhook does NOT fail a template send — don't use that as the failure method.

---

## Part 5 — 24-hour window enforcement

### 5.1 Pre-webhook rejects free-text out-of-window

**Steps:**
1. On a chat task for a conversation with an expired window (or use Appendix A to backdate).
2. Type any free-text message, click Send.

**Pass (server side):**
- Flex surfaces a generic "Could not send message" error inline.
- Twilio does NOT deliver the message (verify via Programmable Messaging logs).
- The pre-webhook logs on error only (silent on happy path), so a successful rejection produces no log line. Diagnose by inspecting the conversation's messages: a rejected send never gets persisted as an `IM…` message resource. Also verify the Programmable Messaging logs don't show an outbound SMS/MMS attempt for the proxy address.

**Pass (plugin side):**
- A warning notification appears: "The 24-hour WhatsApp window has closed. Send a template to reopen the conversation?"
- Two actions: **Reply to me** and **Reply to queue**.
- Click one → current task is parked with that mode, plugin navigates to the composer in reopen-with-template mode (banner + prefilled To).

### 5.2 Pre-webhook does NOT block template sends

**Steps:** on the same expired-window conversation, send a template via the composer.

**Pass:** send succeeds. The pre-webhook short-circuits on `ContentSid` presence.

### 5.3 Pre-webhook does NOT block inbound

**Steps:** phone sends an inbound message to a plugin-managed conversation.

**Pass:** message arrives at the Flex chat canvas; the pre-webhook short-circuits silently on `author.startsWith('whatsapp:')` so inbound traffic is unaffected (verify by sending inbound while on a parked conversation and watching for the "replied" status update in the panel).

### 5.4 Pre-webhook does NOT block non-WA traffic

**Steps:** if you have SMS or email conversations on the same Flex Conversations service, send one.

**Pass:** send succeeds, no measurable extra latency from the pre-webhook (it fast-paths non-WA on `channelType !== 'whatsapp'`).

---

## Part 6 — Open conversations panel

### 6.1 Mine vs All agents toggle

**Steps:** have `<AGENT_A>` and `<AGENT_B>` each own at least one active conversation. Open the panel on `<AGENT_A>`.

**Pass:**
- "Mine" shows only `<AGENT_A>`'s conversations.
- "All agents" shows both.
- Each row renders the initiator name — `<AGENT_A>`'s rows show "you" (not bolded); `<AGENT_B>`'s show "<AGENT_B>" (bolded).

### 6.2 Status transitions live

**Steps:** keep the panel open. Fire a Mode B send from a second browser tab. Reply from the phone.

**Pass:** the row appears with `status: sent`, transitions through `delivered`/`read`, then flips to `replied` without needing to refresh.

### 6.3 Row disappears on conversation close

**Steps:** end an active task → Flex closes the conversation (per Flex docs).

**Pass:** row disappears from both Mine and All agents views within ~1s (via `onConversationStateUpdated`).

### 6.4 Reconciliation on mount (self-heal)

**Steps:**
1. Close a conversation directly via API without going through Flex (to simulate a webhook miss):
   ```bash
   curl -s -u $SID:$TOKEN -X POST \
     "https://conversations.twilio.com/v1/Conversations/<CH>" \
     --data-urlencode "State=closed"
   ```
2. The Sync row might remain. Refresh the plugin tab.

**Pass:** `/verify-active` sweeps rows on mount, detects the closed conversation, and deletes its Sync entries. Row vanishes within 1s of mount.

---

## Part 7 — Auto-close TTL

### 7.1 Short-TTL test (don't wait 5 days)

**Setup:** set `AUTO_CLOSE_AFTER=PT10M` in `serverless/.env` and redeploy. (Twilio enforces a 10-minute minimum — `PT5M` or shorter will fail at `conversation.create` with a validation error.)

**Steps:**
1. Send Mode B template. Don't reply from the phone.
2. Wait slightly over 10 minutes.

**Pass:** at `now - sentAt > 10m`, the conversation state transitions to `closed`. The lifecycle webhook fires and the Sync row disappears from both panels.

**Restore:** change `AUTO_CLOSE_AFTER` back to `P5D` and redeploy.

### 7.2 Timer resets on activity

**Setup:** same `PT10M`.

**Steps:**
1. Send Mode B template. Reply from the phone at minute 8.
2. Verify conversation is still active at minute 12.
3. Wait until minute 20 (no further activity).

**Pass:** conversation closes around the 20-minute mark (10 minutes after the last activity, not the original send).

---

## Part 8 — Configuration knobs

Verify each FLEX_APP_* flag is wired correctly.

### 8.1 `FLEX_APP_SIDE_NAV_LABEL`

**Steps:** set to `WA Composer`, rebuild, refresh.
**Pass:** side-nav item label changes to `WA Composer`.

### 8.2 `FLEX_APP_ENABLE_TEAM_VIEW=false`

**Steps:** set to `false`, rebuild, refresh.
**Pass:** Mine/All agents toggle is hidden. Panel defaults to Mine content.

### 8.3 `FLEX_APP_ENABLE_PARK=false`

**Steps:** set to `false`, rebuild, refresh.
**Pass:** Park (me) and Park (all) buttons do not render on the task canvas. Flex's native End button is left in place (not overridden).

### 8.4 `FLEX_APP_DEFAULT_SEND_MODE`

**Steps:** try each of `same-agent` / `any-agent` / `open-chat`.
**Pass:** the button corresponding to the configured mode appears **first** in the vertical stack. Agents can still click any of the three.

### 8.5 `FLEX_APP_WA_WINDOW_HOURS`

**Steps:** set to `1`, rebuild. Also set serverless `WA_WINDOW_HOURS=1`, redeploy. Send a template, let the customer reply, wait >1h, send another free-text.
**Pass:** pre-webhook rejects after 1h instead of 24h; UI shows "Reopen with template" instead of "Reopen" after 1h.

---

## Part 9 — Negative paths and error handling

### 9.1 Reopen of a closed conversation

**Steps:** end an active task so the conversation closes. Immediately refresh the panel.

**Pass:** the row has disappeared, so the Reopen button isn't clickable. If a stale UI state ever presents it, clicking returns a 409 error toast "Conversation is closed; reopening would create a new conversation and lose history."

### 9.2 Park when the task has already been completed by Flex

**Steps:** complete the task via the native End button first, then (if a stale panel still exposes the Park button) click Park.

**Pass:** function returns a no-op response (`conversation already closed`); no 500 error; Sync rows get cleaned up.

### 9.3 Send with no SYNC_SERVICE_SID

**Steps:** unset `SYNC_SERVICE_SID` in serverless env, redeploy. Send a template.

**Pass:** send succeeds (template delivers); no Sync writes happen; panel stays empty. No error toast — the Sync write is a no-op by design when the service is not configured. (Restore afterward.)

### 9.4 Window-closed toast on a non-WA failure

**Steps:** cause an unrelated chat send failure (e.g. permissions misconfig on an SMS conversation).

**Pass:** our toast does **not** fire for non-WA task failures. Only WA tasks produce the window-closed prompt.

---

## Appendix A — Backdating a Sync entry for 24h tests

Use this to fake "customer replied 25 hours ago" without waiting:

```bash
# Replace <CH>, <WK>, <SYNC_SERVICE>, $SID, $TOKEN appropriately.
OLD=$(node -e "console.log(new Date(Date.now()-25*3600*1000).toISOString())")
MAP="https://sync.twilio.com/v1/Services/<SYNC_SERVICE>/Maps/outbound-sends-<WK>"
DATA=$(curl -s -u $SID:$TOKEN "$MAP/Items/<CH>" | \
  jq -c --arg t "$OLD" '.data | .lastReplyAt=$t | .lastStatusAt=$t')
curl -s -u $SID:$TOKEN -X POST "$MAP/Items/<CH>" \
  --data-urlencode "Data=$DATA"
```

Then exercise 4.3 or 5.1.

---

## Appendix B — Known gaps

What the test plan does NOT cover (and the trade-off):

- **Load / rate limits.** No tests for high-volume sends. Twilio Conversations APS limits (30/s per service) will cap throughput; this plugin isn't designed for bulk and shouldn't be tested as such.
- **Flex version regressions.** The notification wrapper hook was built against Flex 2.18; future versions may surface send-fail errors differently. If a Flex update lands, re-run Part 5 as a smoke test.
- **Lifecycle webhook retry.** The webhook returns 200 on error by design (see ARCHITECTURE "Known limitations"). A failed run is not retried. Production hardening would add an outbox + idempotency key.
