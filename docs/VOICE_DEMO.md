# Voice receptionist demo

**Status:** built behind env config, off until Kelby sets three Railway variables. Kelby chose Retell on Oct 29, 2026, after the demo research ("a browser voice receptionist as the headline demo").
**Depends on:** the live chat facts sheet (`docs/LIVE_CHAT_DEMO.md` §3, real-lead facts from #117). The voice agent uses only **approved** facts.

## 1. What it is
On a shop's chat demo page (`/demo/prototype/:token` on the CRM origin), a **Call the receptionist** panel sits above the text-back phone. The prospect presses it and talks, in the browser, to an AI receptionist that answers in their business name. It reads back their hours, services and towns from the approved facts and declines to guess prices. No phone number is dialed and nothing is booked.

What the caller hears first (a per-call `begin_message`, so it doesn't depend on the Retell setup):
> Thanks for calling *Business*. Quick heads-up: I'm an AI receptionist demo FlowForward built for *Business*, and I'm not connected to their team. Nothing gets booked on this call. How can I help?

That line covers Utah Code 13-77-103's safe harbor (AI disclosed at the start) and the FTC impersonation rule (it says plainly it's a FlowForward demo, not the business). The page banner says the same.

## 2. Out of scope
- An "AI calls your cell" callback. An AI-voice call that markets FlowForward needs prior express written consent under the TCPA (FCC 24-17), so it waits for a lawyer's review of the consent flow.
- A real phone number to dial. That needs carrier registration, and it lets anyone call.
- Showing the transcript in the browser. The SDK's transcript stream needs a key in the browser.
- Storing transcripts or caller details. Only the call length is kept.

## 3. Flow
1. The page reads `GET /api/public/prototypes/:token/voice`. The panel shows only when that returns `available: true`, or `reason: 'limit'` (then it says the link used its calls).
2. **Call** loads `retell-client-js-sdk` 3.0.3 (lazy) and calls `createWebCall`. The SDK's `fetch` is replaced (`web/src/live-chat/voice-client.js`). Only its `/v3/create-web-call` request is sent, to `POST /api/public/prototypes/:token/voice/session`. Every other SDK control request is refused in the browser.
3. The server checks the link and the caps, reserves 3 minutes, then calls Retell `POST /v3/create-web-call` with:
   - `agent_id`: `RETELL_AGENT_ID`;
   - `retell_llm_dynamic_variables`: `business_name`, `business_phone`, `first_town`, `business_facts`;
   - `agent_override.agent`: `max_call_duration_ms` 180000 and `end_call_after_silence_ms` 20000;
   - `agent_override.retell_llm`: the `begin_message` above;
   - `metadata`: `{ ff_call, prototype_id }` (ids only).
4. The server returns only `call_id`, `access_token`, `transport`, `ice_servers` and `expires_at`. The SDK joins the call directly with Retell.
5. Retell posts `call_ended` to `POST /api/public/voice/retell-webhook`. The server verifies `x-retell-signature` and settles the row to the real length.

## 4. Gates, caps and money
**On only when all of these hold.** Turning it on is Kelby's action alone, in Railway. No agent or PR sets these.
- `FF_PROTOTYPE_GALLERY` and `FF_LIVE_CHAT_DEMO` are on. With either off, every voice route is the chat's 404.
- `RETELL_API_KEY` is set (16–200 of `A-Z a-z 0-9 _ -`).
- `RETELL_AGENT_ID` is set (`agent_` plus 8–64 letters or digits).
- `VOICE_DEMO_DAILY_MINUTES` is set: a whole number from 1 to 600, no leading zero, no spaces.
- No default exists for any of the three. Missing or malformed means off: the panel is absent, and a session is 503 `voice_unavailable`.

**Caps** (`VOICE_CAPS`, `src/voicedemo/config.js`):

| Cap | Value | Where |
|---|---|---|
| Call length | 3 min (Retell `max_call_duration_ms`) | Retell, per call |
| Silence | ends 20 s after the agent speaks | Retell, per call |
| Calls per link | 3 | Postgres, advisory-locked |
| Minutes per link | 6 | Postgres, advisory-locked |
| Minutes per day, all links | `VOICE_DEMO_DAILY_MINUTES` | Postgres, advisory-locked |
| Calls at once | 3 | Postgres, advisory-locked |
| Session mints per IP per hour | 4 | in memory, fixed clock-hour bucket |

- **Reservations:**
  - Each mint reserves the full 3 minutes before Retell is asked.
  - A Retell refusal or timeout marks the row `failed`, which releases it.
  - The webhook settles a row to its real length. A row with no end event keeps its full 3 minutes counted, so a missing webhook only makes the caps stricter.
- **Rough cost:** Retell's all-in rate is about $0.11–$0.17 a minute (third-party figures; check retellai.com/pricing). 30 minutes a day is about $3.30–$5.10 a day at most.

## 5. Routes
| Route | Auth | Result |
|---|---|---|
| `GET /api/public/prototypes/:token/voice` | token | 200 `{available:true, max_seconds, calls_left}` · 200 `{available:false, reason:'off'\|'limit'}` · 404 · 410 |
| `POST /api/public/prototypes/:token/voice/session` | token | 415 (not JSON) · 429 `voice_rate` · 404 · 410 · 503 `voice_unavailable` · 429 `{error:'voice_limit', reason:'link'\|'day'\|'busy'}` · 502 `voice_failed` · 201 call fields |
| `POST /api/public/voice/retell-webhook` | `x-retell-signature` | 401 bad or stale signature · 503 no key · 204 |
| `GET /api/chat/voice` | API key | `{configured, daily_minutes, max_call_seconds, calls_per_link, seconds_per_link, today, webhook_url, prompt}`. Never returns the key or the agent id. |

- **Mounting:** the public routes are mounted before `cors()` and the global JSON parser (`src/chatdemo/mount.js`). They use the chat CORS allowlist, and every response sends `noindex`, `no-referrer` and `no-store`.
- **Webhook signature:** `v=<ms>,d=<hex>`, HMAC-SHA256 keyed by the Retell API key over the raw body followed by the timestamp. It must be within 5 minutes, and the comparison is timing-safe.

**Browser policy** (`web/vercel.json`, `/demo/prototype/:token` only):
- `connect-src` adds `https://api.retellai.com`, which carries call signaling for the gateway transport.
- `connect-src` also adds `https://*.livekit.cloud` and `wss://*.livekit.cloud`, for Retell's LiveKit transport and its regional hand-off.
- `Permissions-Policy: microphone=(self)`.
- Media is WebRTC, which `connect-src` does not govern.

## 6. Data
`voice_demo_calls` stores id, prototype_id, Retell call_id, status (`reserved` / `ended` / `failed` / `expired`), reserved and actual seconds, Denver day, and timestamps. It stores no caller number, transcript, IP, name or content. Rows cascade with the prototype.

## 7. Kelby's setup
1. Create a Retell account. Add a few dollars of credit and turn **auto-recharge off**.
2. Create a **Single Prompt** agent:
   - Pick a voice.
   - Paste the prompt from CRM **Settings → Voice receptionist demo → Copy prompt**. The same text is in `src/voicedemo/agent-prompt.js`.
   - Set the agent webhook to the URL shown there, with the `call_ended` event.
3. In Railway, add these variables, and use the redeploy Railway offers:
   - `RETELL_API_KEY`: the secret key.
   - `RETELL_AGENT_ID`: the agent's id.
   - `VOICE_DEMO_DAILY_MINUTES`: for example `30`.
4. Open a prototype chat link with approved facts, press **Call the receptionist**, and talk. Then check **Settings** for today's minutes.

To turn voice off, delete `VOICE_DEMO_DAILY_MINUTES` in Railway.
