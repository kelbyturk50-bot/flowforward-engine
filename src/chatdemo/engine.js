// Chat engine. Caps commit before any responder call. The live gate does not
// reserve; spend.reserve runs only after the gate is true and the prompt fits.
// The ceiling is read from the process env on each reservation.

const crypto = require('crypto');
const { CHAT_CAPS, CAP_CHECKS } = require('./caps');
const { readCeiling } = require('./ceiling');
const {
  CANNED_REPLY,
  FLOWFORWARD_ZONE,
  IDENTITY_REPLY,
  PAUSE_MESSAGE,
  SAMPLE_LEAD_NAME,
  SAMPLE_LEAD_PHONE,
  codePointLength,
  envelope,
  normalize,
  zoneDay,
} = require('./copy');
const { chipLabel } = require('./demos');
const { fixtureRespond, SAMPLE_SLOTS } = require('./fixture-responder');
const { liveRespond } = require('./live-responder');
const { log, logErr } = require('./log');
const { allowedServices, boundTokens, buildPrompt } = require('./prompt');
const { UnpricedModelError, release, reservationUsd, reserve, settle } = require('./spend');
const { withChatTx, pool } = require('./tx');
const { validate } = require('./validator');
const { bucketIp, ipHash } = require('./ip');
const { defaultLiveGate, flags } = require('./wiring');
const counters = require('./counters');

const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
const CHIP_IDS = new Set(['chip_emergency', 'chip_booking', 'chip_price', 'chip_hours', 'chip_area']);
const TOOL_NAMES = new Set(['offer_sample_slots', 'flag_emergency', 'capture_lead', 'handoff_to_human']);
const URGENCY = new Set(['low', 'normal', 'urgent', 'emergency']);
const LEAD_SERVICES = new Set(['water_heater', 'furnace', 'general', 'drain']);
const CAP_CONSTRAINTS = new Set(CAP_CHECKS.map((row) => row[0]));
const CORRECTIVE = 'Reply again using only the facts that were provided. If a detail is not listed, say the team will confirm.';
const CARD_TEXT = Object.freeze({
  offer_sample_slots: 'Sample times, not real availability.',
  flag_emergency: 'Flagged as an emergency in the sample.',
  capture_lead: 'Lead card updated in the sample.',
  handoff_to_human: 'In the live version this would ring the on-call tech.',
});

function createChatEngine(opts = {}) {
  const liveGate = opts.liveGate || defaultLiveGate;
  const fixtureResponder = opts.fixtureResponder || fixtureRespond;
  const model = opts.liveResponder || liveRespond;
  const clock = opts.clock || (() => new Date());
  const spendApi = opts.spend || { reserve, settle, release };
  const countersApi = opts.counters || counters;
  const memory = new Map();

  function priorHistory(id, at) {
    const row = memory.get(id);
    if (!row) return [];
    if (at.getTime() - row.at.getTime() > 30 * 60 * 1000) {
      memory.delete(id);
      return [];
    }
    return row.items.slice(-8);
  }

  function remember(id, at, userText, assistantText) {
    const row = memory.get(id) || { items: [], at };
    if (at.getTime() - row.at.getTime() > 30 * 60 * 1000) row.items = [];
    row.items.push({ role: 'user', text: userText }, { role: 'assistant', text: assistantText });
    if (row.items.length > 40) row.items = row.items.slice(-40);
    row.at = at;
    memory.set(id, row);
  }

  async function safeEvent(fields) {
    try {
      await withChatTx(async (client) => {
        await client.query(
          `INSERT INTO chat_demo_events
             (id, prototype_id, session_id, event_type, chip_id, tool, rule, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            crypto.randomUUID(),
            fields.prototypeId ?? null,
            fields.sessionId ?? null,
            fields.type,
            fields.chipId ?? null,
            fields.tool ?? null,
            fields.rule ?? null,
            fields.at,
          ]
        );
      });
    } catch (err) {
      logErr('cap_store_unavailable', err);
    }
  }

  async function safeTouch(business, type, sessionUuid, at) {
    if (!business.prospectId || !sessionUuid) return;
    try {
      if (!(await flags('FF_CAMPAIGNS'))) return;
      if (!String(business.company || '').startsWith('TEST:')) return;
      const external = `TEST:chatdemo:${sessionUuid}`;
      if (type === 'prototype_viewed') {
        const existing = await pool.query(
          `SELECT 1 FROM campaign_touches WHERE external_ref = $1 AND type = 'prototype_viewed' LIMIT 1`,
          [external]
        );
        if (existing.rowCount) return;
      }
      await pool.query(
        `INSERT INTO campaign_touches (lead_id, type, channel, occurred_at, source, external_ref)
         VALUES ($1, $2, 'prototype_link', $3, 'system', $4)`,
        [business.prospectId, type, at, external]
      );
    } catch (err) {
      logErr('cap_store_unavailable', err);
    }
  }

  function failPaused(business) {
    return {
      status: 503,
      body: envelope(business, {
        error: 'demo_paused',
        pause_message: PAUSE_MESSAGE,
        paused: true,
      }),
    };
  }

  function limited(business) {
    return {
      status: 429,
      body: envelope(business, {
        error: 'demo_limit',
        message: 'Demo limit reached',
      }),
    };
  }

  function serverError(business) {
    return {
      status: 500,
      body: envelope(business, { error: 'server_error' }),
    };
  }

  function isCapViolation(err) {
    return Boolean(err && err.code === '23514' && CAP_CONSTRAINTS.has(err.constraint));
  }

  function invalid(business) {
    return {
      status: 400,
      body: envelope(business, { error: 'invalid_body' }),
    };
  }

  function labelFor(business, chipId) {
    const chips = business.chips || [];
    const found = chips.find((chip) => chip.id === chipId);
    if (found) return found.label;
    return chipLabel(chipId, factValue(business.facts, 'service_area'));
  }

  function parseIncoming(ctx) {
    const body = ctx.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: invalid(ctx.business) };
    if (typeof body.sessionId !== 'string' || !SESSION_RE.test(body.sessionId)) {
      if (body.sessionId == null || body.sessionId === '') return { error: invalid(ctx.business) };
      return { error: { status: 404 } };
    }
    let chipId = null;
    if (body.chipId != null) {
      if (typeof body.chipId !== 'string' || !CHIP_IDS.has(body.chipId)) return { error: invalid(ctx.business) };
      chipId = body.chipId;
    }
    let text = typeof body.text === 'string' ? body.text : '';
    if (!text && chipId) text = labelFor(ctx.business, chipId) || '';
    if (!text) return { error: invalid(ctx.business) };
    const normalized = text.normalize('NFKC');
    return {
      sessionId: body.sessionId,
      text: normalized,
      chipId,
      chars: codePointLength(normalized),
    };
  }

  async function findSession(sessionId, linkKey) {
    const hash = crypto.createHash('sha256').update(sessionId, 'utf8').digest();
    const row = await countersApi.loadSession(hash);
    if (!row) return null;
    const stored = Buffer.isBuffer(row.session_hash) ? row.session_hash : Buffer.from(row.session_hash);
    if (stored.length !== hash.length || !crypto.timingSafeEqual(stored, hash)) return null;
    if (row.link_key !== linkKey) return null;
    return row;
  }

  function expired(row, at) {
    return !(new Date(row.expires_at).getTime() > at.getTime());
  }

  async function openSession(ctx) {
    const at = clock();
    const business = ctx.business;
    let hashed;
    try {
      hashed = await ipHash(bucketIp(ctx.ip), at);
    } catch (err) {
      logErr('cap_store_unavailable', err);
      return failPaused(business);
    }
    try {
      await countersApi.purge(at);
    } catch (err) {
      logErr('ip_purge_failed', err);
    }
    let prepared;
    try {
      prepared = await countersApi.prepareMint({ linkKey: business.linkKey, ipHash: hashed, at });
    } catch (err) {
      logErr('cap_store_unavailable', err);
      return failPaused(business);
    }
    if (!prepared.ok) {
      await safeEvent({ prototypeId: business.prototypeId, type: 'cap_hit', at });
      return limited(business);
    }
    const sessionId = crypto.randomBytes(32).toString('base64url');
    let expiresAt = new Date(at.getTime() + 30 * 60 * 1000);
    if (business.linkExpires) {
      const linkEnd = new Date(business.linkExpires);
      if (linkEnd.getTime() < expiresAt.getTime()) expiresAt = linkEnd;
    }
    const session = {
      id: crypto.randomUUID(),
      prototypeId: business.prototypeId ?? null,
      hash: crypto.createHash('sha256').update(sessionId, 'utf8').digest(),
      testTag: business.test_tag,
      expiresAt,
    };
    try {
      await countersApi.runMint({ linkKey: business.linkKey, ipHash: hashed, at, session });
    } catch (err) {
      if (isCapViolation(err)) {
        countersApi.rememberBumps(prepared.keys);
        await safeEvent({ prototypeId: business.prototypeId, type: 'cap_hit', at });
        return limited(business);
      }
      logErr('cap_store_unavailable', err);
      return serverError(business);
    }
    countersApi.rememberBumps(prepared.keys);
    await safeEvent({
      prototypeId: business.prototypeId,
      sessionId: session.id,
      type: 'chat_viewed',
      at,
    });
    await safeTouch(business, 'prototype_viewed', session.id, at);
    return {
      status: 201,
      body: envelope(business, {
        sessionId,
        expires_at: expiresAt.toISOString(),
        disclosure: business.disclosure,
      }),
    };
  }

  function sampleService(facts, message, chipId, tools) {
    const captured = (tools || []).find((tool) => tool.name === 'capture_lead' || tool.name === 'flag_emergency');
    let raw = captured ? captured.args.service : 'general';
    if (!captured) {
      const folded = normalize(message);
      if (folded.includes('water heater') || chipId === 'chip_emergency') raw = 'water_heater';
      else if (folded.includes('furnace') || chipId === 'chip_price') raw = 'furnace';
      else if (folded.includes('drain')) raw = 'drain';
    }
    if (!allowedServices(facts).has(raw) || !LEAD_SERVICES.has(raw)) return 'general';
    return raw;
  }

  function urgencyFor(tools, chipId) {
    const tool = (tools || []).find((item) => item.args && URGENCY.has(item.args.urgency));
    if (tool) return tool.args.urgency;
    if (chipId === 'chip_emergency') return 'emergency';
    return 'normal';
  }

  function present(spec) {
    const tools = spec.tools || [];
    const cards = tools.map((tool) => ({
      name: tool.name,
      args: tool.args,
      card: CARD_TEXT[tool.name],
    }));
    const slots = cards.some((tool) => tool.name === 'offer_sample_slots') ? SAMPLE_SLOTS.slice() : [];
    const service = sampleService(spec.facts, spec.message, spec.chipId, tools);
    const urgency = urgencyFor(tools, spec.chipId);
    const costMicros = spec.costMicros || 0;
    return {
      text: spec.text,
      lead: tools.some((tool) => tool.name === 'capture_lead')
        ? { service, urgency }
        : null,
      fields: {
        source: spec.source,
        outputTokens: spec.outputTokens == null || spec.outputTokens > CHAT_CAPS.maxOutputTokens
          ? null
          : spec.outputTokens,
        costUsd: costMicros > 0 ? (costMicros / 1e6).toFixed(6) : null,
        boundTokens: spec.boundTokens == null ? null : spec.boundTokens,
      },
      body: {
        text: spec.text,
        tools: cards,
        slots,
        source: spec.source,
        paused: !!spec.paused,
        pause_message: spec.paused ? PAUSE_MESSAGE : null,
        sample_lead: {
          name: SAMPLE_LEAD_NAME,
          phone: SAMPLE_LEAD_PHONE,
          service,
          urgency,
        },
      },
    };
  }

  function scripted(facts, message, chipId) {
    try {
      const reply = fixtureResponder({ facts, message, chipId }) || {};
      const tools = validateTools(reply.tools, facts);
      const claims = validate(reply.text || '', facts);
      if (!tools.ok || !claims.ok || !reply.text) {
        if (!tools.ok) log('tool_call_dropped');
        if (!claims.ok || !reply.text) log('validator_fallback');
        return { text: CANNED_REPLY, tools: [] };
      }
      return { text: reply.text, tools: tools.tools };
    } catch (err) {
      log('responder_fallback');
      return { text: CANNED_REPLY, tools: [] };
    }
  }

  function asksIfAi(text) {
    const folded = normalize(text);
    return /\bare you\b/.test(folded) && /\b(bot|ai|human)\b/.test(folded);
  }

  async function postMessage(ctx) {
    const at = clock();
    const business = ctx.business;
    const parsed = parseIncoming(ctx);
    if (parsed.error) return parsed.error;
    let row;
    try {
      row = await findSession(parsed.sessionId, business.linkKey);
    } catch (err) {
      logErr('cap_store_unavailable', err);
      return failPaused(business);
    }
    if (!row || expired(row, at)) return { status: 404 };
    if (parsed.chars > CHAT_CAPS.maxMessageChars) {
      return { status: 413, body: envelope(business, { error: 'message_too_long' }) };
    }
    const zone = business.time_zone || FLOWFORWARD_ZONE;
    let hashed;
    try {
      hashed = await ipHash(bucketIp(ctx.ip), at);
    } catch (err) {
      logErr('cap_store_unavailable', err);
      return failPaused(business);
    }
    let prepared;
    try {
      prepared = await countersApi.prepareMessage({
        sessionId: row.id,
        linkKey: business.linkKey,
        ipHash: hashed,
        at,
        zone,
        loadedCount: Number(row.message_count),
      });
    } catch (err) {
      logErr('cap_store_unavailable', err);
      return failPaused(business);
    }
    if (!prepared.ok) {
      await safeEvent({ prototypeId: business.prototypeId, sessionId: row.id, type: 'cap_hit', at });
      return limited(business);
    }
    let turnId;
    try {
      turnId = await countersApi.runMessage({
        sessionId: row.id,
        linkKey: business.linkKey,
        ipHash: hashed,
        at,
        zone,
        chars: parsed.chars,
        prototypeId: business.prototypeId ?? null,
        chipId: parsed.chipId,
      });
    } catch (err) {
      if (isCapViolation(err)) {
        countersApi.rememberBumps(prepared.keys);
        await safeEvent({ prototypeId: business.prototypeId, sessionId: row.id, type: 'cap_hit', at });
        return limited(business);
      }
      logErr('cap_store_unavailable', err);
      return serverError(business);
    }
    countersApi.rememberBumps(prepared.keys);
    if (parsed.chipId) {
      await safeEvent({
        prototypeId: business.prototypeId,
        sessionId: row.id,
        type: 'chip_clicked',
        chipId: parsed.chipId,
        at,
      });
    }

    let outcome;
    try {
      // Tokenless demo businesses are fixture-only. They never enter the
      // live gate, the spend reservation, or the model.
      outcome = business.fixtureOnly
        ? scriptedReply(business, parsed)
        : await answer({ business, row, turnId, parsed, at });
    } catch (err) {
      logErr('cap_store_unavailable', err);
      return failPaused(business);
    }
    if (outcome.stop === 'paused') return failPaused(business);
    remember(row.id, at, parsed.text, outcome.text);
    try {
      await countersApi.finishTurn(turnId, outcome.fields);
    } catch (err) {
      logErr('cap_store_unavailable', err);
    }
    if (outcome.lead) {
      try {
        await withChatTx(async (client) => {
          await client.query(
            `INSERT INTO chat_demo_leads
               (prototype_id, session_id, service, urgency, test_tag, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              business.prototypeId ?? null,
              row.id,
              outcome.lead.service,
              outcome.lead.urgency,
              row.test_tag,
              at,
            ]
          );
        });
      } catch (err) {
        logErr('cap_store_unavailable', err);
      }
    }
    for (const tool of outcome.body.tools) {
      await safeEvent({
        prototypeId: business.prototypeId,
        sessionId: row.id,
        type: 'tool_card_shown',
        tool: tool.name,
        at,
      });
    }
    await safeEvent({
      prototypeId: business.prototypeId,
      sessionId: row.id,
      type: outcome.fields.source === 'live' ? 'responder_live' : 'responder_fixture',
      at,
    });
    return { status: 200, body: envelope(business, outcome.body) };
  }

  function scriptedReply(business, parsed) {
    if (asksIfAi(parsed.text)) {
      return present({
        text: IDENTITY_REPLY,
        tools: [],
        source: 'fixture',
        facts: business.facts,
        message: parsed.text,
        chipId: parsed.chipId,
      });
    }
    return fromFixture(business, parsed, { paused: false });
  }

  async function answer({ business, row, turnId, parsed, at }) {
    if (asksIfAi(parsed.text)) {
      const shown = present({
        text: IDENTITY_REPLY,
        tools: [],
        source: 'fixture',
        facts: business.facts,
        message: parsed.text,
        chipId: parsed.chipId,
      });
      return shown;
    }
    let live = false;
    try {
      live = await liveGate({ capHit: false, linkKey: business.linkKey });
    } catch (err) {
      logErr('cap_store_unavailable', err);
      live = false;
    }
    if (!live) return fromFixture(business, parsed, { paused: false });

    const prompt = buildPrompt({
      facts: business.facts,
      history: priorHistory(row.id, at),
      message: parsed.text,
    });
    if (!prompt.ok) {
      log('prompt_over_cap');
      await safeEvent({
        prototypeId: business.prototypeId,
        sessionId: row.id,
        type: 'prompt_over_cap',
        at,
      });
      return fromFixture(business, parsed, { paused: false, boundTokens: prompt.boundTokens });
    }
    let amount;
    try {
      amount = reservationUsd();
    } catch (err) {
      if (err instanceof UnpricedModelError || (err && err.code === 'model_unpriced')) {
        log('model_unpriced');
        await safeEvent({
          prototypeId: business.prototypeId,
          sessionId: row.id,
          type: 'model_unpriced',
          at,
        });
        return fromFixture(business, parsed, { paused: false, boundTokens: prompt.boundTokens });
      }
      throw err;
    }
    const ceiling = readCeiling(process.env);
    if (ceiling == null) return fromFixture(business, parsed, { paused: false, boundTokens: prompt.boundTokens });

    const firstHold = await hold(business, row, turnId, amount, ceiling, at);
    if (firstHold.stop) return firstHold;
    if (!firstHold.id) {
      log('demo_paused');
      await safeEvent({ prototypeId: business.prototypeId, sessionId: row.id, type: 'demo_paused', at });
      return fromFixture(business, parsed, { paused: true, boundTokens: prompt.boundTokens });
    }

    let first;
    try {
      first = shapeCall(await model({ prompt }));
    } catch (err) {
      return fallbackCall(err, firstHold.id, amount, at, business, row, parsed, prompt.boundTokens);
    }
    await noteBound(first, prompt.boundTokens, business, row, at);
    const settled = await spendApi.settle({ id: firstHold.id, actualMicros: first.costMicros, at });
    if (settled && settled.overshoot > 0) {
      await safeEvent({ prototypeId: business.prototypeId, sessionId: row.id, type: 'spend_overshoot', at });
    }
    let cost = first.costMicros;
    const factsSent = prompt.factsSent;
    const tools = validateTools(first.tools, factsSent);
    const claims = first.text ? validate(first.text, factsSent) : { ok: false, hits: [{ rule: 'empty' }] };
    if (!tools.ok) {
      log('tool_call_dropped');
      await safeEvent({
        prototypeId: business.prototypeId,
        sessionId: row.id,
        type: 'tool_call_dropped',
        at,
      });
      return fromFixture(business, parsed, {
        paused: false,
        text: CANNED_REPLY,
        tools: [],
        source: 'live',
        costMicros: cost,
        outputTokens: first.usage.output,
        boundTokens: prompt.boundTokens,
        skipScript: true,
      });
    }
    if (claims.ok) {
      return fromFixture(business, parsed, {
        paused: false,
        text: first.text,
        tools: tools.tools,
        source: 'live',
        costMicros: cost,
        outputTokens: first.usage.output,
        boundTokens: prompt.boundTokens,
        skipScript: true,
      });
    }

    const extra = boundTokens([first.text, CORRECTIVE]);
    if (prompt.boundTokens + extra > CHAT_CAPS.maxInputTokens) {
      log('prompt_over_cap');
      log('validator_fallback');
      await safeEvent({
        prototypeId: business.prototypeId,
        sessionId: row.id,
        type: 'validator_fallback',
        rule: claims.hits[0] ? claims.hits[0].rule : null,
        at,
      });
      return cannedLive(business, parsed, cost, first.usage.output, prompt.boundTokens);
    }
    const secondCeiling = readCeiling(process.env);
    if (secondCeiling == null) {
      log('validator_fallback');
      return cannedLive(business, parsed, cost, first.usage.output, prompt.boundTokens);
    }
    const secondHold = await hold(business, row, turnId, amount, secondCeiling, at);
    if (secondHold.stop) return secondHold;
    if (!secondHold.id) {
      log('demo_paused');
      log('validator_fallback');
      await safeEvent({ prototypeId: business.prototypeId, sessionId: row.id, type: 'demo_paused', at });
      await safeEvent({
        prototypeId: business.prototypeId,
        sessionId: row.id,
        type: 'validator_fallback',
        rule: claims.hits[0] ? claims.hits[0].rule : null,
        at,
      });
      return cannedLive(business, parsed, cost, first.usage.output, prompt.boundTokens, true);
    }
    const retry = {
      ...prompt,
      messages: [
        ...prompt.messages,
        { role: 'assistant', content: first.text },
        { role: 'user', content: CORRECTIVE },
      ],
    };
    let second;
    try {
      second = shapeCall(await model({ prompt: retry }));
    } catch (err) {
      if (err && err.code === 'not_sent') {
        await spendApi.release(secondHold.id, at);
      } else {
        await spendApi.settle({ id: secondHold.id, actualMicros: amount, at });
        cost += amount;
      }
      log('responder_fallback');
      log('validator_fallback');
      await safeEvent({ prototypeId: business.prototypeId, sessionId: row.id, type: 'responder_fallback', at });
      return cannedLive(business, parsed, cost, first.usage.output, prompt.boundTokens);
    }
    await noteBound(second, prompt.boundTokens + extra, business, row, at);
    const secondSettled = await spendApi.settle({ id: secondHold.id, actualMicros: second.costMicros, at });
    if (secondSettled && secondSettled.overshoot > 0) {
      await safeEvent({ prototypeId: business.prototypeId, sessionId: row.id, type: 'spend_overshoot', at });
    }
    cost += second.costMicros;
    const secondTools = validateTools(second.tools, factsSent);
    const secondClaims = second.text ? validate(second.text, factsSent) : { ok: false, hits: [{ rule: 'empty' }] };
    if (!secondTools.ok || !secondClaims.ok) {
      if (!secondTools.ok) {
        log('tool_call_dropped');
        await safeEvent({ prototypeId: business.prototypeId, sessionId: row.id, type: 'tool_call_dropped', at });
      }
      log('validator_fallback');
      await safeEvent({
        prototypeId: business.prototypeId,
        sessionId: row.id,
        type: 'validator_fallback',
        rule: (secondClaims.hits[0] && secondClaims.hits[0].rule) || (claims.hits[0] && claims.hits[0].rule) || null,
        at,
      });
      return cannedLive(business, parsed, cost, second.usage.output, prompt.boundTokens);
    }
    log('validator_rewrote');
    await safeEvent({
      prototypeId: business.prototypeId,
      sessionId: row.id,
      type: 'validator_rewrote',
      rule: claims.hits[0] ? claims.hits[0].rule : null,
      at,
    });
    return fromFixture(business, parsed, {
      paused: false,
      text: second.text,
      tools: secondTools.tools,
      source: 'live',
      costMicros: cost,
      outputTokens: second.usage.output,
      boundTokens: prompt.boundTokens,
      skipScript: true,
    });
  }

  function cannedLive(business, parsed, costMicros, outputTokens, boundTokensValue, paused) {
    return fromFixture(business, parsed, {
      paused: !!paused,
      text: CANNED_REPLY,
      tools: [],
      source: 'live',
      costMicros,
      outputTokens,
      boundTokens: boundTokensValue,
      skipScript: true,
    });
  }

  async function hold(business, row, turnId, amount, ceiling, at) {
    try {
      const id = await spendApi.reserve({
        day: zoneDay(at, FLOWFORWARD_ZONE),
        turnId,
        amountMicros: amount,
        ceilingMicros: ceiling,
        at,
      });
      return { id };
    } catch (err) {
      logErr('cap_store_unavailable', err);
      return { stop: 'paused' };
    }
  }

  async function fallbackCall(err, reservationId, amount, at, business, row, parsed, bound) {
    if (err && err.code === 'not_sent') {
      try { await spendApi.release(reservationId, at); } catch (releaseErr) {
        logErr('cap_store_unavailable', releaseErr);
      }
    } else {
      try { await spendApi.settle({ id: reservationId, actualMicros: amount, at }); } catch (settleErr) {
        logErr('cap_store_unavailable', settleErr);
      }
    }
    log('responder_fallback');
    await safeEvent({ prototypeId: business.prototypeId, sessionId: row.id, type: 'responder_fallback', at });
    return fromFixture(business, parsed, {
      paused: false,
      boundTokens: bound,
      costMicros: err && err.code === 'not_sent' ? 0 : amount,
    });
  }

  function noteBound(call, bound, business, row, at) {
    const usage = call.usage || {};
    const used = (usage.input || 0) + (usage.cacheWrite || 0) + (usage.cacheRead || 0);
    if (used > bound) {
      log('input_bound_exceeded');
      return safeEvent({
        prototypeId: business.prototypeId,
        sessionId: row.id,
        type: 'input_bound_exceeded',
        at,
      });
    }
    return null;
  }

  function fromFixture(business, parsed, extra) {
    const script = extra.skipScript
      ? { text: extra.text, tools: extra.tools || [] }
      : scripted(business.facts, parsed.text, parsed.chipId);
    return present({
      text: script.text,
      tools: script.tools,
      source: extra.source || 'fixture',
      paused: extra.paused,
      facts: business.facts,
      message: parsed.text,
      chipId: parsed.chipId,
      costMicros: extra.costMicros || 0,
      outputTokens: extra.outputTokens,
      boundTokens: extra.boundTokens,
    });
  }

  async function postCta(ctx) {
    const at = clock();
    const business = ctx.business;
    const body = ctx.body;
    if (!body || typeof body.sessionId !== 'string' || !SESSION_RE.test(body.sessionId)) {
      if (body && typeof body.sessionId === 'string' && body.sessionId) return { status: 404 };
      return invalid(business);
    }
    let row;
    try {
      row = await findSession(body.sessionId, business.linkKey);
    } catch (err) {
      logErr('cap_store_unavailable', err);
      return failPaused(business);
    }
    if (!row || expired(row, at)) return { status: 404 };
    await safeEvent({
      prototypeId: business.prototypeId,
      sessionId: row.id,
      type: 'cta_clicked',
      at,
    });
    await safeTouch(business, 'prototype_cta_clicked', row.id, at);
    return {
      status: 200,
      body: envelope(business, { ok: true }),
    };
  }

  return { openSession, postMessage, postCta, clock };
}

function factValue(facts, field) {
  const row = (facts || []).find((item) => item.field === field && item.value);
  return row ? String(row.value) : '';
}

function shapeCall(call) {
  const usage = call && call.usage ? call.usage : {};
  return {
    text: call && typeof call.text === 'string' ? call.text : '',
    tools: call && Array.isArray(call.tools) ? call.tools : [],
    usage: {
      input: usage.input || 0,
      output: usage.output || 0,
      cacheWrite: usage.cacheWrite || 0,
      cacheRead: usage.cacheRead || 0,
    },
    costMicros: Number.isSafeInteger(call && call.costMicros) ? call.costMicros : 0,
  };
}

function validateTools(tools, facts) {
  if (!Array.isArray(tools)) return { ok: false, tools: [] };
  const allowed = allowedServices(facts);
  const clean = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || !TOOL_NAMES.has(tool.name)) return { ok: false, tools: [] };
    const args = tool.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, tools: [] };
    const permitted = tool.name === 'offer_sample_slots'
      ? ['service', 'urgency', 'slot']
      : ['service', 'urgency'];
    if (Object.keys(args).some((key) => !permitted.includes(key))) return { ok: false, tools: [] };
    if (typeof args.service !== 'string' || !allowed.has(args.service)) return { ok: false, tools: [] };
    if (!URGENCY.has(args.urgency)) return { ok: false, tools: [] };
    if (tool.name === 'offer_sample_slots' && args.slot != null && args.slot !== 0 && args.slot !== 1 && args.slot !== 2) {
      return { ok: false, tools: [] };
    }
    const next = { name: tool.name, args: { service: args.service, urgency: args.urgency } };
    if (tool.name === 'offer_sample_slots' && args.slot != null) next.args.slot = args.slot;
    clean.push(next);
  }
  return { ok: true, tools: clean };
}

module.exports = { createChatEngine, validateTools, CARD_TEXT };
