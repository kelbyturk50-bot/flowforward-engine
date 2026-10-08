#!/usr/bin/env node
// FlowForward Discovery Bot
// Searches Google Places for home service SMBs across your target markets
// and upserts them into the prospects table.
//
// Run manually:  node src/bot/discover.js
// Run on cron:   started automatically by src/server.js

require('dotenv').config();
const pool = require('../db/client');
const { searchPlaces, normalizePplace } = require('./google-places');
const INDUSTRIES = require('./industries');
const { rescore } = require('../scoring/fit');

const TARGET_MARKETS = (process.env.TARGET_MARKETS || 'Salt Lake City UT')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

const RESULTS_PER_QUERY = parseInt(process.env.RESULTS_PER_QUERY || '20', 10);
const MIN_RATING        = parseFloat(process.env.MIN_RATING || '0');

// ─── Upsert a single prospect ──────────────────────────────────────────────
async function upsertProspect(data) {
  const {
    google_place_id, company, industry, phone, website,
    address, city, state, zip, rating, review_count, score, source, stage
  } = data;

  const res = await pool.query(
    `INSERT INTO prospects
       (google_place_id, company, industry, phone, website,
        address, city, state, zip, rating, review_count, score, source, stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (google_place_id) DO NOTHING
     RETURNING id`,
    [google_place_id, company, industry, phone, website,
     address, city, state, zip, rating, review_count, score, source, stage]
  );

  // Returns a row if new, empty if duplicate
  return res.rows.length > 0;
}

// ─── Main discovery run ────────────────────────────────────────────────────
async function runDiscovery() {
  console.log(`\n[bot] ═══ FlowForward Discovery Bot ═══`);
  console.log(`[bot] Markets: ${TARGET_MARKETS.join(', ')}`);
  console.log(`[bot] Industries: ${INDUSTRIES.length} query types`);
  console.log(`[bot] Started: ${new Date().toISOString()}\n`);

  // Log the run start
  const runRes = await pool.query(
    `INSERT INTO discovery_runs (status) VALUES ('running') RETURNING id`
  );
  const runId = runRes.rows[0].id;

  let queriesRun = 0, totalFound = 0, newAdded = 0, errors = 0;
  outer: for (const market of TARGET_MARKETS) {
    for (const { query, industry, score } of INDUSTRIES) {
      queriesRun++;
      const label = `${query} in ${market}`;

      try {
        console.log(`[bot] Searching: "${label}"`);
        const places = await searchPlaces(query, market, RESULTS_PER_QUERY);
        totalFound += places.length;

        let marketNew = 0;
        for (const place of places) {
          // Skip permanently closed
          if (place.businessStatus === 'CLOSED_PERMANENTLY') continue;
          // Skip below minimum rating
          if (MIN_RATING > 0 && place.rating && place.rating < MIN_RATING) continue;

          const normalized = normalizePplace(place, industry, score);
          const isNew = await upsertProspect(normalized);
          if (isNew) { newAdded++; marketNew++; }
        }

        console.log(`[bot]   → ${places.length} found, ${marketNew} new`);

        // Polite delay between API calls (avoid rate limits)
        await sleep(300);

      } catch (err) {
        errors++;
        const status = err.response?.status;
        const reason = err.response?.data?.error?.status;
        console.error(`[bot] ✗ Error on "${label}": ${err.message}`);
        // Stop immediately on quota exhaustion — resets at midnight Pacific
        if (status === 429 || reason === 'RESOURCE_EXHAUSTED') {
          console.error('[bot] ✗ Daily quota exhausted — stopping early. Try again tomorrow.');
          break outer;
        }
        await sleep(1000);
      }
    }
  }

  // Update run log
  await pool.query(
    `UPDATE discovery_runs
     SET finished_at=$1, queries_run=$2, found=$3, new_added=$4, errors=$5, status=$6
     WHERE id=$7`,
    [new Date(), queriesRun, totalFound, newAdded, errors, errors > 0 ? 'done_with_errors' : 'done', runId]
  );

  // Rank everything (new leads + any config changes)
  try {
    const n = await rescore();
    console.log(`[bot] Fit scores refreshed for ${n} prospects`);
  } catch (err) {
    console.error('[bot] ✗ Rescore failed:', err.message);
  }

  console.log(`\n[bot] ═══ Run Complete ═══`);
  console.log(`[bot] Queries run : ${queriesRun}`);
  console.log(`[bot] Total found : ${totalFound}`);
  console.log(`[bot] New added   : ${newAdded}`);
  console.log(`[bot] Errors      : ${errors}`);
  console.log(`[bot] Finished    : ${new Date().toISOString()}\n`);

  return { queriesRun, totalFound, newAdded, errors };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Run directly if called as script ─────────────────────────────────────
if (require.main === module) {
  runDiscovery()
    .then(() => pool.end())
    .catch(err => { console.error('[bot] Fatal:', err); process.exit(1); });
}

module.exports = { runDiscovery };
