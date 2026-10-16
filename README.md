# FlowForward Engine

Automated prospect discovery for FlowForward AI Consulting. Finds home service SMBs (HVAC, roofing, landscaping, plumbing, pest control, etc.) across your target markets using the Google Places API and stores them in PostgreSQL.

## What it does

- **Discovery bot** — queries Google Places for 22 industry types × your target markets, deduplicates by Place ID, and upserts new leads into the database
- **REST API** — serves prospect data to the FlowForward Pipeline dashboard
- **Scheduled cron** — runs discovery automatically every morning at 6am

## Stack

- Node.js + Express
- PostgreSQL
- Google Places API (New)
- Hosted on Railway

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/kelbyturk50-bot/flowforward-engine
cd flowforward-engine
npm install
```

### 2. Get a Google Places API key

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → Enable **Places API (New)**
3. Create an API key → copy it

Free tier gives you $200/month credit — enough for ~5,000 searches/day, far more than you'll need.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:
```
DATABASE_URL=...        # from Railway (see below)
GOOGLE_PLACES_API_KEY=  # your key from step 2
TARGET_MARKETS=Salt Lake City UT,Provo UT,Ogden UT
```

### 4. Deploy to Railway

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Select `kelbyturk50-bot/flowforward-engine`
3. Add a **PostgreSQL** plugin (Railway → New → Database → PostgreSQL)
4. Railway auto-sets `DATABASE_URL` — just add your other env vars in the Variables tab
5. Deploy

### 5. Run database migration

In Railway's shell tab (or locally):
```bash
node src/db/migrate.js
```

### 6. Trigger first discovery run

```bash
# Manually (local or Railway shell)
node src/bot/discover.js

# Or via API
curl -X POST https://your-railway-url.railway.app/api/runs/trigger
```

---

## API Reference

All `/api/*` routes require the `x-api-key` header once `CRM_API_KEY` is set.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check (no key needed) |
| GET | `/api/focus` | Today queue: follow-ups due, best untouched leads, gone-quiet deals, tasks due this week |
| GET | `/api/prospects` | Leads, ranked by fit. Filters: `stage` (list, `open`, `closed`), `tier`, `industry`, `city`, `q`, `min_fit`, `sort`, `limit`, `offset` |
| POST | `/api/prospects` | Add a lead by hand |
| GET | `/api/prospects/stats` | Counts by stage, tier, industry |
| GET | `/api/prospects/meta` | Filter options (stages, industries, cities) |
| POST | `/api/prospects/rescore` | Recompute every fit score |
| GET | `/api/prospects/:id` | Lead with activity log and linked projects |
| PATCH | `/api/prospects/:id` | Update stage, contact info, next step, value, fit boost, notes |
| POST | `/api/prospects/:id/activities` | Log a call, email, meeting or note |
| POST | `/api/prospects/:id/convert` | Mark won and create a linked project |
| DELETE | `/api/prospects/:id` | Remove a lead |
| GET/POST | `/api/projects` | List or create projects (client-linked or internal) |
| GET/PATCH/DELETE | `/api/projects/:id` | One project with its tasks |
| POST | `/api/projects/:id/tasks` | Add a task |
| PATCH/DELETE | `/api/tasks/:id` | Update or remove a task |
| GET | `/api/runs` | Last 20 discovery run logs |
| POST | `/api/runs/trigger` | Manually trigger a discovery run |

## Fit scoring

Every lead gets a 0–100 fit score and an A–D tier, recomputed on boot, after each discovery run, and whenever a scoring input changes. The breakdown is stored in `fit_reasons` and shown in the CRM.

| Factor | Points | Logic |
|---|---|---|
| Industry | 30 | Automation leverage per trade (`src/scoring/config.js`) |
| Size | 25 | Review count as a job-volume proxy; sweet spot 75–400 |
| Reputation | 10 | Google rating |
| Reachability | 15 | Real website + phone (social-only pages score lower) |
| Location | 10 | In your drive-to cities (`FIT_HOME_CITIES`) |
| Franchise | −20 | National brands / franchises |
| Your boost | ±20 | Manual adjustment per lead |

Tiers: A ≥ 80, B ≥ 65, C ≥ 50, D below. Tune everything in `src/scoring/config.js`, then hit "Re-rank all leads" in Settings.

## CRM frontend (`web/`)

Vite + React app deployed on Vercel. Views: Today, Leads, Pipeline (drag-and-drop), Projects, Settings.

```bash
cd web && npm install && npm run dev   # http://localhost:5173
cd web && npm test                     # Vitest, mocked API, no network
cd web && npm run lint
```

How the CRM tests run is in `web/README.md`.

Deploy: Vercel → Add New Project → import this repo → set **Root Directory** to `web` → deploy. The production CRM hostnames use the built-in API address. Preview hostnames do not call an API until `VITE_API_URL` points at a staging API (or someone types an address in Settings). On first open, enter the API key in Settings (stored per device). See `web/README.md`.

--------|------|-------------|
| GET | `/health` | Server health check |
| GET | `/api/prospects` | All prospects (optional `?stage=found&industry=HVAC`) |
| GET | `/api/prospects/stats` | Pipeline counts by stage/industry |
| GET | `/api/prospects/:id` | Single prospect |
| PATCH | `/api/prospects/:id` | Update stage, score, note, brief, outreach |
| DELETE | `/api/prospects/:id` | Remove a prospect |
| GET | `/api/runs` | Last 20 discovery run logs |
| POST | `/api/runs/trigger` | Manually trigger a discovery run |

---

## Proposal bot

Drafting runs **on demand**: on the CRM's **Proposals** page, pick how many and click **Draft**, and the bot takes your top **A-tier** leads (stage `found`, not Pest Control, no proposal yet), researches them, and writes drafts for review. You can also draft for any single lead from its page. Nothing is ever sent until you click **Approve and send**. (Set `PROPOSAL_AUTO_DRAFT=1` to also draft automatically each night at `PROPOSAL_CRON`.)

**Per lead it:**
1. Reads their website (homepage + contact/about/services pages): emails, contact form, socials, and the tools they run (ServiceTitan, Housecall Pro, Jobber, Podium, chat widgets, booking, financing, site builder).
2. Pulls up to 5 Google review texts and hours (Place Details).
3. Has Claude (with a few web searches for the owner's name and socials) write: an analysis for you, a cold email, day-3 and day-10 follow-ups, and a personalized one-page proposal served at `/p/<slug>`.
4. Flags poor fits (franchise, closed, wrong trade) and moves them to *Not a fit*; restore any you disagree with.

**Sending** goes through Gmail (`flowforward50@gmail.com`) using the **Gmail API over HTTPS**, because Railway blocks SMTP on non-Pro plans. Mail still lands in that account's Sent folder and replies in its inbox. Connect it once from the CRM: **Settings → Email sending → Connect Gmail**. Follow-ups go out as replies in the same Gmail thread on weekdays 8am–5pm. Every 15 minutes the bot checks the inbox and stops the sequence when the lead replies, books on Calendly, bounces, or asks not to be contacted (opt-outs are marked do-not-contact). Emails are plain text with one link and a CAN-SPAM footer (your mailing address + opt-out line). (If `GMAIL_USER` + `GMAIL_APP_PASSWORD` are set and Gmail isn't connected, it falls back to SMTP/IMAP, which only works on Railway Pro.)

**Tuning:** edit any draft before sending (the AI's original is kept so edits can be compared), leave 👍/👎 and a note, ask for a rewrite with instructions, and set standing voice rules in **Settings → Proposal voice**. The bot reads your notes, recent feedback, and the last few emails you rewrote before sending on every new draft. The prompt and per-trade playbooks live in `src/proposals/prompt.js`.

### Railway variables

| Variable | Required | Default / notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | From platform.claude.com → API keys |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | to send | OAuth client from Google Cloud (see *Gmail setup* below), then click **Connect Gmail** in the CRM |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | no | SMTP fallback; only works on Railway Pro |
| `SENDER_ADDRESS` | to send | Mailing address for the email footer (a PO box or virtual mailbox works) |
| `SENDER_PHONE` | no | Shown on the one-pager and allowed in signatures |
| `CALENDLY_URL` | no | `https://calendly.com/flowforward50` |
| `PUBLIC_BASE_URL` | no | Where one-pagers are served; set this if you add a custom domain |
| `PROPOSAL_MODEL` | no | `claude-sonnet-5-5` |
| `PROPOSAL_NIGHTLY_COUNT` | no | `5` |
| `PROPOSAL_TIERS` | no | `A` (e.g. `A,B` later) |
| `EXCLUDED_INDUSTRIES` | no | `Pest Control` (also skipped by discovery) |
| `PROPOSAL_AUTO_DRAFT` | no | off. `1` = also draft automatically each night |
| `PROPOSAL_CRON` | no | `0 3 * * *` (only used when auto-draft is on) |
| `PROPOSAL_WEB_SEARCH` / `PROPOSAL_WEB_SEARCH_MAX` | no | on / `3` searches per lead |
| `PROPOSAL_FETCH_REVIEWS` | no | on (Place Details, 1,000 free/month) |
| `PROPOSAL_MAX_COST` | no | `0.75` USD hard cap per draft |
| `SEND_DAILY_LIMIT` | no | `20` emails/day including follow-ups |
| `FOLLOWUP_DAYS` | no | `3,10` |
| `SEND_HOURS` / `SEND_DAYS` | no | `8,17` / `1,2,3,4,5` |

### Gmail setup (one time, ~15 minutes)
1. [console.cloud.google.com](https://console.cloud.google.com) → create a project (e.g. "FlowForward").
2. **APIs & Services → Library** → enable **Gmail API**.
3. **Google Auth platform → Branding → Get started**: app name "FlowForward", support email flowforward50@gmail.com, audience **External**, contact email, agree, Create.
4. **Audience → Publish app** (move it to *In production*). Apps left in *Testing* lose access every 7 days. It stays unverified, which is fine for your own account.
5. **Clients → Create client** → type **Web application** → under *Authorized redirect URIs* add `https://<your-railway-domain>/oauth/google/callback` (shown in CRM Settings) → Create. Copy the client ID and secret.
6. Railway → Variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Redeploy.
7. CRM → Settings → **Connect Gmail** → sign in as flowforward50@gmail.com → on "Google hasn't verified this app" click **Advanced → Go to FlowForward** → allow both Gmail permissions.

### Endpoints

| Method | Path | |
|---|---|---|
| GET | `/api/proposals?view=review\|out\|replied\|flagged\|closed` or `?prospect_id=` | Lists |
| GET | `/api/proposals/summary` | Counts, setup problems, spend, sends today |
| POST | `/api/proposals` `{prospect_id, instructions}` | Draft one now (any tier, ~1 min) |
| GET/PATCH | `/api/proposals/:id` | Full proposal + versions + rendered email / edit copy, feedback |
| POST | `/api/proposals/:id/send` | Approve and send the first email |
| POST | `/api/proposals/:id/regenerate` `{instructions, fresh_research}` | New version |
| POST | `/api/proposals/:id/stop` · `/replied` · `/discard` · `/restore` | Sequence control |
| GET/POST | `/api/proposals/runs` · `/runs/trigger` | Drafting run history / draft N now |
| GET/PUT | `/api/proposals/settings` | Voice notes |
| POST | `/api/proposals/check-inbox` | Check replies + send due follow-ups now |
| GET/POST | `/api/proposals/gmail/status` · `/gmail/connect` · `/gmail/disconnect` | Gmail connection |
| GET | `/oauth/google/callback` | Google sign-in return (public) |
| GET | `/p/:slug` | Public one-pager (`?preview=1` doesn't count a view) |

## Target markets

Edit `TARGET_MARKETS` in your `.env` file. Format: `City State` (comma-separated).

Default: Utah County + Salt Lake Valley

## Industries tracked

22 search query types across: HVAC, Roofing, Landscaping, Plumbing, Electrical, Pest Control, Cleaning, Painting, Gutters, Windows, General Contractors.

Edit `src/bot/industries.js` to add or remove.

---

## Local development

```bash
npm run dev     # start server with nodemon
npm run bot     # run discovery manually
npm run migrate # apply schema
```
