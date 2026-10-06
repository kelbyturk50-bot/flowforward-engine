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

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check |
| GET | `/api/prospects` | All prospects (optional `?stage=found&industry=HVAC`) |
| GET | `/api/prospects/stats` | Pipeline counts by stage/industry |
| GET | `/api/prospects/:id` | Single prospect |
| PATCH | `/api/prospects/:id` | Update stage, score, note, brief, outreach |
| DELETE | `/api/prospects/:id` | Remove a prospect |
| GET | `/api/runs` | Last 20 discovery run logs |
| POST | `/api/runs/trigger` | Manually trigger a discovery run |

---

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
