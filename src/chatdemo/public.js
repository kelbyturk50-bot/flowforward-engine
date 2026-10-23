// Public chat routes. Mounted before cors() and the global JSON parser.
// express.json({ limit: '2kb' }) is the first middleware on each chat router.

const express = require('express');
const { clientIp } = require('../pilot/rate-limit');
const { lookupToken } = require('../prototypes/store');
const { effective } = require('../flags/resolve');
const { banner, disclosure, envelope, perGoogle, PAUSE_MESSAGE, WATERMARK_TEXT } = require('./copy');
const { chipsFor, listDemos, demoBySlug } = require('./demos');
const { createChatEngine } = require('./engine');
const { tagForCompany } = require('./facts-store');
const { log, logErr } = require('./log');
const pool = require('../db/client');

const NOT_FOUND = Buffer.from('{"error":"not_found"}');
const TOO_LARGE = Buffer.from('{"error":"payload_too_large"}');

let engineOverride = null;
let defaultEngine = null;

function engine() {
  if (engineOverride) return engineOverride;
  if (!defaultEngine) defaultEngine = createChatEngine();
  return defaultEngine;
}

function _setEngineForTests(next) {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  engineOverride = next || null;
  if (!next) defaultEngine = null;
}

function stamp(res) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
}

function send404(res) {
  stamp(res);
  res.status(404);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.end(NOT_FOUND);
}

function send410(res, expiresAt) {
  const body = JSON.stringify({
    error: 'link_expired',
    expires_at: new Date(expiresAt).toISOString(),
  });
  stamp(res);
  res.status(410);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

function send413(res) {
  stamp(res);
  log('payload_too_large');
  res.status(413);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.end(TOO_LARGE);
}

function sendResult(res, result) {
  if (!result || result.status === 404) return send404(res);
  if (result.status === 410) return send410(res, result.expires_at);
  res.status(result.status).json(result.body);
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function flagsOn() {
  try {
    const [gallery, demo] = await Promise.all([
      effective('FF_PROTOTYPE_GALLERY'),
      effective('FF_LIVE_CHAT_DEMO'),
    ]);
    return gallery.effective === true && demo.effective === true;
  } catch (err) {
    logErr('cap_store_unavailable', err);
    return false;
  }
}

function publicDemo(demo) {
  return {
    slug: demo.slug,
    business_name: demo.business_name,
    colors: { primary: demo.colors.primary, secondary: demo.colors.secondary },
    banner: demo.banner,
    disclosure: demo.disclosure,
    facts: demo.facts.map((fact) => ({
      field: fact.field,
      value: fact.value,
      source: fact.source,
      per_google: fact.per_google === true,
    })),
    chips: demo.chips.map((chip) => ({ id: chip.id, label: chip.label })),
  };
}

function businessFromDemo(demo) {
  return {
    slug: demo.slug,
    business_name: demo.business_name,
    colors: { primary: demo.colors.primary, secondary: demo.colors.secondary },
    phone: demo.phone,
    test_tag: demo.test_tag,
    time_zone: demo.time_zone,
    banner: demo.banner,
    disclosure: demo.disclosure,
    facts: demo.facts,
    chips: demo.chips,
    prototypeId: null,
    prospectId: null,
    company: '',
    linkKey: `demo:${demo.slug}`,
    linkExpires: null,
  };
}

function sessionTag(company) {
  if (String(company || '').startsWith('TEST:')) {
    const tag = tagForCompany(company);
    if (tag) return tag;
  }
  return 'demo-prototype';
}

async function businessFromRow(row) {
  const [factsResult, leadResult] = await Promise.all([
    pool.query(
      `SELECT field, value, source, source_url, snippet
         FROM prototype_facts
        WHERE prospect_id = $1
        ORDER BY field`,
      [row.prospect_id]
    ),
    pool.query(`SELECT company FROM prospects WHERE id = $1`, [row.prospect_id]),
  ]);
  const facts = factsResult.rows.map((fact) => ({
    field: fact.field,
    value: fact.value,
    source: fact.source,
    source_url: fact.source_url,
    snippet: fact.snippet,
    per_google: perGoogle(fact),
  }));
  const by = new Map(facts.map((fact) => [fact.field, fact.value]));
  const company = leadResult.rows[0] ? leadResult.rows[0].company : '';
  const name = by.get('business_name') || row.brand_name;
  const phone = by.get('phone') || '';
  const serviceArea = by.get('service_area') || '';
  return {
    business_name: name,
    colors: { primary: row.color_primary, secondary: row.color_secondary },
    phone,
    test_tag: sessionTag(company),
    time_zone: by.get('time_zone') || 'America/Denver',
    banner: banner(name),
    disclosure: disclosure(name, phone),
    facts,
    chips: chipsFor(serviceArea),
    prototypeId: row.id,
    prospectId: row.prospect_id,
    company,
    linkKey: `prototype:${row.id}`,
    linkExpires: row.expires_at,
  };
}

async function resolveDemo(slug) {
  const [on, demo] = await Promise.all([
    flagsOn(),
    Promise.resolve(demoBySlug(slug)),
  ]);
  if (!on || !demo) return null;
  return demo;
}

async function resolvePrototype(token) {
  const [flagResult, lookResult] = await Promise.allSettled([
    flagsOn(),
    lookupToken(token),
  ]);
  const on = flagResult.status === 'fulfilled' && flagResult.value === true;
  if (!on) return { status: 404 };
  if (lookResult.status !== 'fulfilled') return { status: 503 };
  const looked = lookResult.value;
  if (looked.status === 404) return { status: 404 };
  if (looked.status === 410) return { status: 410, expires_at: looked.row.expires_at };
  try {
    const business = await businessFromRow(looked.row);
    return { status: 200, business };
  } catch (err) {
    logErr('cap_store_unavailable', err);
    return { status: 503 };
  }
}

function pausedBody() {
  return envelope(
    { business_name: 'this business', colors: { primary: '#1b4f72', secondary: '#f4d03f' } },
    { error: 'demo_paused', pause_message: PAUSE_MESSAGE, paused: true }
  );
}

function createRouter(kind) {
  const router = express.Router({ mergeParams: true });
  router.use(express.json({ limit: '2kb' }));
  router.use((req, res, next) => {
    stamp(res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  if (kind === 'demo') {
    router.get('/demos', wrap(async (req, res) => {
      if (!(await flagsOn())) return send404(res);
      res.json({
        watermark: WATERMARK_TEXT,
        demos: listDemos().map(publicDemo),
      });
    }));
    router.post('/demos/:slug/session', wrap(async (req, res) => {
      const demo = await resolveDemo(req.params.slug);
      if (!demo) return send404(res);
      sendResult(res, await engine().openSession({ business: businessFromDemo(demo), ip: clientIp(req) }));
    }));
    router.post('/demos/:slug/message', wrap(async (req, res) => {
      const demo = await resolveDemo(req.params.slug);
      if (!demo) return send404(res);
      sendResult(res, await engine().postMessage({
        business: businessFromDemo(demo),
        ip: clientIp(req),
        body: req.body,
      }));
    }));
    router.post('/demos/:slug/cta', wrap(async (req, res) => {
      const demo = await resolveDemo(req.params.slug);
      if (!demo) return send404(res);
      sendResult(res, await engine().postCta({
        business: businessFromDemo(demo),
        ip: clientIp(req),
        body: req.body,
      }));
    }));
  } else {
    router.post('/session', wrap(async (req, res) => {
      const resolved = await resolvePrototype(req.params.token);
      if (resolved.status === 404) return send404(res);
      if (resolved.status === 410) return send410(res, resolved.expires_at);
      if (resolved.status === 503) return res.status(503).json(pausedBody());
      sendResult(res, await engine().openSession({ business: resolved.business, ip: clientIp(req) }));
    }));
    router.post('/message', wrap(async (req, res) => {
      const resolved = await resolvePrototype(req.params.token);
      if (resolved.status === 404) return send404(res);
      if (resolved.status === 410) return send410(res, resolved.expires_at);
      if (resolved.status === 503) return res.status(503).json(pausedBody());
      sendResult(res, await engine().postMessage({
        business: resolved.business,
        ip: clientIp(req),
        body: req.body,
      }));
    }));
    router.post('/cta', wrap(async (req, res) => {
      const resolved = await resolvePrototype(req.params.token);
      if (resolved.status === 404) return send404(res);
      if (resolved.status === 410) return send410(res, resolved.expires_at);
      if (resolved.status === 503) return res.status(503).json(pausedBody());
      sendResult(res, await engine().postCta({
        business: resolved.business,
        ip: clientIp(req),
        body: req.body,
      }));
    }));
  }

  router.use((req, res) => send404(res));
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
      return send413(res);
    }
    if (err && (err.type === 'entity.parse.failed' || err.status === 400 || err.statusCode === 400)) {
      stamp(res);
      return res.status(400).json({
        error: 'invalid_body',
        watermark: WATERMARK_TEXT,
        banner: banner('this business'),
      });
    }
    logErr('cap_store_unavailable', err);
    stamp(res);
    return res.status(503).json(pausedBody());
  });
  return router;
}

const demoRouter = createRouter('demo');
const prototypeChatRouter = createRouter('prototype');

module.exports = {
  demoRouter,
  prototypeChatRouter,
  _setEngineForTests,
};
