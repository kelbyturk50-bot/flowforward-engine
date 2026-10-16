// Proposal bot configuration. Everything here can be overridden with Railway
// Variables; the defaults match how Kelby sells today.

const { EXCLUDED_INDUSTRIES } = require('../scoring/config');

const list = (v, d) => (v ?? d).split(',').map(s => s.trim()).filter(Boolean);
const num  = (v, d) => (v == null || v === '' || isNaN(Number(v)) ? d : Number(v));

const SENDER = {
  name:      process.env.SENDER_NAME     || 'Kelby Turk',
  title:     process.env.SENDER_TITLE    || 'Process Engineer & Founder',
  company:   process.env.SENDER_COMPANY  || 'FlowForward',
  email:     process.env.GMAIL_USER      || 'flowforward50@gmail.com',
  phone:     process.env.SENDER_PHONE    || '',
  calendly:  process.env.CALENDLY_URL    || 'https://calendly.com/flowforward50',
  hometown:  process.env.SENDER_HOMETOWN || 'Saratoga Springs, Utah',
  // Physical mailing address — required by CAN-SPAM in every commercial email.
  // Sending is blocked until this is set.
  address:   process.env.SENDER_ADDRESS  || '',
};

// Where the one-pager pages are served from (this API). Point a custom domain
// at Railway later and set this to it — a branded domain reads better in email.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ||
  'https://flowforward-engine-production.up.railway.app').replace(/\/+$/, '');

const MODEL = process.env.PROPOSAL_MODEL || 'claude-sonnet-5-5';

// USD per million tokens. Keep in sync with https://platform.claude.com/docs/en/about-claude/pricing
const PRICES = {
  'claude-sonnet-5-5': { in: 2,  out: 10 },
  'claude-sonnet-5':   { in: 2,  out: 10 },
  'claude-opus-5-5':   { in: 4,  out: 20 },
  'claude-haiku-5-5':  { in: 0.10, out: 0.50 },
  'claude-sonnet-4-6': { in: 3,  out: 15 },
};
const WEB_SEARCH_PRICE = 0.01; // $10 per 1,000 searches

// Cache reads cost 0.05x input on Sonnet/Opus 5.5, 0.1x on older models; 5-minute cache writes cost 1.25x.
const CACHE_READ = { 'claude-sonnet-5-5': 0.05, 'claude-opus-5-5': 0.05 };

function costOf(model, { input = 0, output = 0, cacheWrite = 0, cacheRead = 0, searches = 0 } = {}) {
  const p = PRICES[model] || PRICES['claude-sonnet-5-5'];
  const readMult = CACHE_READ[model] ?? 0.1;
  return (input * p.in + cacheWrite * p.in * 1.25 + cacheRead * p.in * readMult + output * p.out) / 1e6
    + searches * WEB_SEARCH_PRICE;
}

const config = {
  SENDER,
  PUBLIC_BASE_URL,
  MODEL,
  costOf,
  // Which leads the nightly run drafts for
  NIGHTLY_COUNT:       num(process.env.PROPOSAL_NIGHTLY_COUNT, 5),
  TIERS:               list(process.env.PROPOSAL_TIERS, 'A'),
  // Same list discovery skips and computeFit hard-demotes. Defined in src/scoring/config.js.
  EXCLUDED_INDUSTRIES,
  // Automatic nightly drafting is OFF unless PROPOSAL_AUTO_DRAFT=1. Drafts are made on demand from the CRM.
  AUTO_DRAFT:          process.env.PROPOSAL_AUTO_DRAFT === '1',
  CRON:                process.env.PROPOSAL_CRON || '0 3 * * *',      // used only when AUTO_DRAFT is on
  // Research
  WEB_SEARCH:          process.env.PROPOSAL_WEB_SEARCH !== '0',        // let Claude search the web (owner name, socials, news)
  WEB_SEARCH_MAX:      num(process.env.PROPOSAL_WEB_SEARCH_MAX, 3),
  FETCH_REVIEWS:       process.env.PROPOSAL_FETCH_REVIEWS !== '0',     // Google review text via Place Details
  MAX_SITE_PAGES:      num(process.env.PROPOSAL_MAX_SITE_PAGES, 5),
  MAX_COST_PER_LEAD:   num(process.env.PROPOSAL_MAX_COST, 0.75),       // hard stop on runaway loops
  // Sending
  SEND_DAILY_LIMIT:    num(process.env.SEND_DAILY_LIMIT, 20),          // first emails + follow-ups combined
  FOLLOWUP_DAYS:       list(process.env.FOLLOWUP_DAYS, '3,10').map(Number),
  SEND_TZ:             process.env.CRON_TZ || 'America/Denver',
  SEND_HOURS:          list(process.env.SEND_HOURS, '8,17').map(Number), // follow-ups go out 8am–5pm…
  SEND_DAYS:           list(process.env.SEND_DAYS, '1,2,3,4,5').map(Number), // …Mon–Fri (0 = Sunday)
  SENDER_CRON:         process.env.SENDER_CRON || '*/15 * * * *',        // follow-ups + inbox check
};

config.mailConfigured = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
config.anthropicConfigured = () => !!process.env.ANTHROPIC_API_KEY;

module.exports = config;
