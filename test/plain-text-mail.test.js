process.env.CRM_API_KEY = 'test-plain-text-mail-key-32chars-min';
process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SEND_DAILY_LIMIT = '100';
process.env.SENDER_ADDRESS = '1 Test Street, Provo, UT 84601';
delete process.env.FF_PROTOTYPE_ON_DRAFT;

require('./preload');

// F-011. Intros and follow-ups are one text/plain part. The stubbed transport
// captures the mail object; the raw bytes come from the same MailComposer
// call the send path uses. Nothing here reaches Gmail.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const MailComposer = require('nodemailer/lib/mail-composer');
const send = require('../src/proposals/send');
const inbox = require('../src/proposals/inbox');
const store = require('../src/prototypes/store');
const cfg = require('../src/proposals/config');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const BODY = 'Hi Dana,\n\nNoticed you offer free estimates.\n\nI put a few ideas for Sample Heating on one page here:\n{{ONEPAGER_URL}}\n\nHappy to answer questions.\n\nKelby\nKelby Turk, Founder';
const F1 = 'Hi Dana,\n\nThe notes are still on one page here:\n{{ONEPAGER_URL}}\n\nKelby';
const F2 = 'Closing the loop. The page is here if you want it:\n{{ONEPAGER_URL}}\n\nKelby';

let n = 0;
let seq = 0;
const sent = [];

function rawMime(mail) {
  return new MailComposer({ ...mail, threadId: undefined }).compile().build();
}

function parseMime(raw) {
  const text = (Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).toString('latin1');
  const sep = text.indexOf('\r\n\r\n');
  assert.ok(sep > 0, 'mime headers end with a blank line');
  const headers = [];
  for (const line of text.slice(0, sep).split('\r\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && headers.length) {
      headers[headers.length - 1].value += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    assert.ok(colon > 0, `header line: ${line}`);
    headers.push({ name: line.slice(0, colon), value: line.slice(colon + 1).trim() });
  }
  return { headers, body: text.slice(sep + 4), text };
}

function headerValues(parsed, name) {
  return parsed.headers.filter(h => h.name.toLowerCase() === name.toLowerCase()).map(h => h.value);
}

async function expectedText(proposalId, which) {
  const { rows } = await pool.query(
    `SELECT pr.*, p.company FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.id = $1`,
    [proposalId]);
  const p = rows[0];
  const link = await store.liveLink(p.prospect_id);
  p.prototype_url = link ? link.url : null;
  return { text: send.renderMessage(p, which), link, subject: p.subject, to: p.to_email };
}

async function assertPlain(mail, proposalId, which) {
  const expected = await expectedText(proposalId, which);
  assert.equal(mail.html, undefined, `${which} has no html part`);
  assert.equal(mail.textEncoding, 'base64');
  assert.equal(mail.text, expected.text, 'mail.text is renderMessage');
  assert.equal(Buffer.from(mail.text, 'utf8').equals(Buffer.from(expected.text, 'utf8')), true);
  assert.deepEqual(mail.from, { name: cfg.SENDER.name, address: cfg.SENDER.email });
  assert.deepEqual(mail.to, { name: 'Dana', address: expected.to });
  const subject = which === 'first' ? expected.subject : `Re: ${expected.subject}`;
  assert.equal(mail.subject, subject);
  assert.deepEqual(mail.headers, {
    'List-Unsubscribe': `<mailto:${cfg.SENDER.email}?subject=unsubscribe>`,
  });

  const raw = await rawMime(mail);
  const parsed = parseMime(raw);
  assert.deepEqual(headerValues(parsed, 'content-type'), ['text/plain; charset=utf-8']);
  assert.deepEqual(headerValues(parsed, 'content-transfer-encoding'), ['base64'],
    'quoted-printable would soft-break a long URL');
  const head = parsed.headers.map(h => `${h.name}: ${h.value}`).join('\n');
  assert.equal(/multipart/i.test(head), false);
  assert.equal(/text\/html/i.test(head), false);
  assert.equal(parsed.text.includes('flowforward-logo'), false, 'no logo url in the raw message');
  assert.equal(/\.(?:png|jpe?g|gif|webp)/i.test(parsed.text), false, 'no image in the raw message');
  assert.equal(headerValues(parsed, 'from')[0], `${cfg.SENDER.name} <${cfg.SENDER.email}>`);
  assert.equal(headerValues(parsed, 'to')[0], `Dana <${expected.to}>`);
  assert.equal(headerValues(parsed, 'subject')[0], subject);
  assert.equal(headerValues(parsed, 'list-unsubscribe')[0], `<mailto:${cfg.SENDER.email}?subject=unsubscribe>`);

  const decoded = Buffer.from(parsed.body, 'base64');
  assert.equal(decoded.equals(Buffer.from(expected.text, 'utf8')), true, 'decoded body is byte-identical to renderMessage');
  const text = decoded.toString('utf8');
  assert.equal(text.includes(`${cfg.PUBLIC_BASE_URL}/p/`), true, 'one-pager link');
  assert.equal(text.includes('Not interested? Reply "no thanks"'), true, 'opt-out line');
  assert.equal(text.includes(`${cfg.SENDER.company} · ${cfg.SENDER.address}`), true, 'CAN-SPAM footer');
  assert.equal(text.includes('flowforward-logo'), false);
  const urls = text.match(/https?:\/\/\S+/g) || [];
  assert.ok(urls.length >= 1);
  for (const url of urls) {
    assert.equal(/\s/.test(url), false, url);
    assert.equal(text.split(url).length - 1 >= 1, true);
  }
  if (which === 'first') assert.equal(text.includes(cfg.SENDER.calendly), true, 'Calendly line');
  else assert.equal(text.includes(cfg.SENDER.calendly), false, 'follow-ups do not add a calendar line');
  if (expected.link && which !== 'followup2') {
    assert.equal(text.includes(expected.link.url), true, 'prototype link');
    assert.ok(expected.link.url.length > 76, 'the fixture URL is long enough to be wrapped');
  } else {
    assert.equal(text.includes('/demo/prototype/'), false);
  }
  return { raw, parsed, expected };
}

async function draftFor() {
  n += 1;
  const email = `test+plain${n}@example.com`;
  const prospect = await insertProspect({
    website: null, email, company: `TEST: Sample Heating ${n}`, industry: 'HVAC',
    city: 'Lehi', state: 'UT', phone: '(801) 555-0148',
    google_place_id: `test-place-plain-mail-${n}`,
  });
  const { rows } = await pool.query(
    `INSERT INTO proposals (prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2)
     VALUES ($1, 1, 'draft', $2, $3, 'Dana', 'ideas for sample heating', $4, $5, $6) RETURNING id`,
    [prospect.id, `plain-${prospect.id}`, email, BODY, F1, F2]);
  return { prospect, proposalId: rows[0].id, email };
}

async function sendIntro(withLink) {
  const row = await draftFor();
  if (withLink) await store.ensurePrototype(row.prospect.id);
  sent.length = 0;
  await send.approveAndSend(row.proposalId);
  assert.equal(sent.length, 1);
  row.mail = sent[0];
  return row;
}

async function sendFollowup(withLink, which) {
  const row = await sendIntro(withLink);
  await pool.query(`UPDATE proposals SET followup1_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [row.proposalId]);
  sent.length = 0;
  const first = await send.sendDueFollowups();
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);
  row.followup1 = sent[0];
  if (which === 'followup2') {
    await pool.query(`UPDATE proposals SET followup2_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [row.proposalId]);
    sent.length = 0;
    const second = await send.sendDueFollowups();
    assert.equal(second.sent, 1);
    assert.equal(sent.length, 1);
    row.followup2 = sent[0];
  }
  return row;
}

describe('plain text outreach', { concurrency: false }, () => {
  before(async () => { await resetDb(); });
  beforeEach(() => {
    sent.length = 0;
    send._setTransport({
      async sendMail(mail) {
        sent.push(mail);
        seq += 1;
        return { messageId: `<plain-${seq}@example.com>`, threadId: `thr-plain-${seq}`, id: `gm-plain-${seq}` };
      },
    });
  });
  after(async () => { send._setTransport(null); await closePool(); });

  it('intro with a live prototype link is one text/plain part', async () => {
    const row = await sendIntro(true);
    assert.equal(row.mail.threadId, undefined);
    assert.equal(row.mail.inReplyTo, undefined);
    assert.equal(row.mail.references, undefined);
    const { parsed } = await assertPlain(row.mail, row.proposalId, 'first');
    assert.deepEqual(headerValues(parsed, 'in-reply-to'), []);
    assert.deepEqual(headerValues(parsed, 'references'), []);
  });

  it('intro without a prototype link is one text/plain part', async () => {
    const row = await sendIntro(false);
    await assertPlain(row.mail, row.proposalId, 'first');
  });

  it('follow-up 1 with a live prototype link is one text/plain part', async () => {
    const row = await sendFollowup(true, 'followup1');
    await assertPlain(row.followup1, row.proposalId, 'followup1');
  });

  it('follow-up 1 without a prototype link is one text/plain part', async () => {
    const row = await sendFollowup(false, 'followup1');
    await assertPlain(row.followup1, row.proposalId, 'followup1');
  });

  it('follow-up 2 with a live prototype link is one text/plain part', async () => {
    const row = await sendFollowup(true, 'followup2');
    await assertPlain(row.followup2, row.proposalId, 'followup2');
  });

  it('follow-up 2 without a prototype link is one text/plain part', async () => {
    const row = await sendFollowup(false, 'followup2');
    await assertPlain(row.followup2, row.proposalId, 'followup2');
  });

  it('follow-up threading headers are unchanged', async () => {
    const row = await sendFollowup(true, 'followup2');
    const { rows } = await pool.query(
      'SELECT message_id, thread_id, subject FROM proposals WHERE id = $1', [row.proposalId]);
    const stored = rows[0];
    assert.equal(row.mail.threadId, undefined);
    assert.equal(row.mail.inReplyTo, undefined);
    assert.equal(row.mail.references, undefined);
    assert.equal(row.mail.subject, stored.subject);
    for (const mail of [row.followup1, row.followup2]) {
      assert.equal(mail.threadId, stored.thread_id);
      assert.equal(mail.inReplyTo, stored.message_id);
      assert.deepEqual(mail.references, [stored.message_id]);
      assert.equal(mail.subject, `Re: ${stored.subject}`);
      assert.deepEqual(mail.from, row.mail.from);
      assert.deepEqual(mail.to, row.mail.to);
      assert.deepEqual(mail.headers, row.mail.headers);
      const parsed = parseMime(await rawMime(mail));
      assert.deepEqual(headerValues(parsed, 'in-reply-to'), [stored.message_id]);
      assert.deepEqual(headerValues(parsed, 'references'), [stored.message_id]);
      assert.equal(headerValues(parsed, 'subject')[0], `Re: ${stored.subject}`);
    }
    const intro = parseMime(await rawMime(row.mail));
    assert.deepEqual(headerValues(intro, 'in-reply-to'), []);
    assert.deepEqual(headerValues(intro, 'references'), []);
  });

  it('inbox replies still send their HTML part', async () => {
    const row = await draftFor();
    const reply = 'Hi Dana,\n\nYes, the booking form can take that. Happy to walk through it.\n\nKelby';
    const { rows: msgs } = await pool.query(
      `INSERT INTO inbox_messages
         (prospect_id, direction, dedupe_key, thread_id, header_message_id, from_addr, subject, body)
       VALUES ($1, 'in', $2, 'thr-reply', '<reply@example.com>', 'test+reply@example.com', 'Re: ideas', 'Sounds good')
       RETURNING id`,
      [row.prospect.id, `plain-reply-${n}`]);
    const { rows: items } = await pool.query(
      `INSERT INTO inbox_items
         (prospect_id, message_id, status, reply_to, reply_subject, reply_body)
       VALUES ($1, $2, 'ready', 'test+reply@example.com', 'Re: ideas for sample heating', $3)
       RETURNING id`,
      [row.prospect.id, msgs[0].id, reply]);
    sent.length = 0;
    const saved = await inbox.sendReply(items[0].id);
    assert.equal(saved.status, 'sent');
    assert.equal(sent.length, 1);
    const mail = sent[0];
    assert.equal(mail.text, reply);
    assert.equal(typeof mail.html, 'string');
    assert.equal(mail.html.includes('/brand/flowforward-logo.png'), true);
    assert.equal(mail.html.includes('Happy to walk through it'), true);
    assert.equal(mail.inReplyTo, '<reply@example.com>');
    assert.deepEqual(mail.references, ['<reply@example.com>']);
    assert.equal(mail.threadId, 'thr-reply');
    const parsed = parseMime(await rawMime(mail));
    assert.match(parsed.text, /multipart\/alternative/i);
    assert.match(parsed.text, /Content-Type:\s*text\/html/i);
    assert.match(parsed.text, /Content-Type:\s*text\/plain/i);
    assert.equal(headerValues(parsed, 'content-type').some(v => /multipart\/alternative/i.test(v)), true);
  });
});
