// Lead research: crawl the company's website, detect the tools they already use,
// collect contact emails and social profiles, and pull Google review text.
// Everything returned here is raw evidence; Claude does the interpretation.

const axios   = require('axios');
const cheerio = require('cheerio');
const { MAX_SITE_PAGES, FETCH_REVIEWS } = require('./config');
const { SOCIAL_HOSTS } = require('../scoring/config');
const {
  SERVICETITAN_RE, SERVICETITAN_SCHEDULER_RE, ST_FSM_LABEL, ST_SCHEDULER_LABEL,
} = require('./servicetitan');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const PAGE_TEXT_LIMIT  = 4000;   // chars kept per page
const TOTAL_TEXT_LIMIT = 14000;  // chars kept across the site

// Internal pages worth reading after the homepage, best first
const PAGE_HINTS = [
  /contact/i, /about|our-?story|who-we-are|team|meet/i, /services?|what-we-do/i,
  /book|schedule|appointment/i, /estimate|quote|pricing/i, /reviews?|testimonials?/i,
];

// Fingerprints in page HTML (scripts, iframes, links) → what they already run
const SIGNATURES = {
  field_service_software: {
    [ST_FSM_LABEL]: SERVICETITAN_RE, 'Housecall Pro': /housecallpro|housecall pro/i, 'Jobber': /getjobber|jobber\.com/i,
    'Workiz': /workiz/i, 'FieldEdge': /fieldedge/i, 'Service Fusion': /servicefusion/i, 'ServiceM8': /servicem8/i,
    'GorillaDesk': /gorilladesk/i, 'Markate': /markate/i, 'Kickserv': /kickserv/i, 'JobNimbus': /jobnimbus/i,
    'AccuLynx': /acculynx/i, 'LMN': /golmn|lmn\.com/i, 'Aspire': /youraspire/i,
  },
  online_booking: {
    'Calendly': /calendly\.com/i, 'Acuity': /acuityscheduling/i, 'Setmore': /setmore/i, 'Square Appointments': /squareup\.com\/appointments/i,
    'Housecall Pro booking': /book\.housecallpro|housecallpro\.com\/book/i, 'Jobber requests': /clienthub\.getjobber|jobber.*request/i,
    [ST_SCHEDULER_LABEL]: SERVICETITAN_SCHEDULER_RE, 'Schedule Engine': /scheduleengine/i,
  },
  chat_or_text_widget: {
    'Podium': /podium/i, 'Birdeye': /birdeye/i, 'Tawk.to': /tawk\.to/i, 'Intercom': /intercom/i, 'Drift': /drift\.com|js\.driftt/i,
    'LiveChat': /livechatinc/i, 'Tidio': /tidio/i, 'HubSpot chat': /js\.hs-scripts|hubspot/i, 'Zendesk': /zdassets|zendesk/i,
    'Facebook Messenger': /connect\.facebook\.net.*customerchat|xfbml\.customerchat/i, 'Smith.ai': /smith\.ai/i, 'Ruby': /ruby\.com/i,
    'Hatch': /usehatchapp|hatch\.co/i, 'Leadferno': /leadferno/i, 'GoHighLevel': /leadconnectorhq|msgsndr|gohighlevel/i,
  },
  reviews_tools: {
    'Birdeye': /birdeye/i, 'Podium': /podium/i, 'NiceJob': /nicejob/i, 'Grade.us': /grade\.us/i, 'Elfsight reviews': /elfsight/i,
    'Trustindex': /trustindex/i, 'ReviewBuzz': /reviewbuzz/i,
  },
  financing: {
    'Synchrony': /synchrony/i, 'GreenSky': /greensky/i, 'Wisetack': /wisetack/i, 'Service Finance': /svcfin|servicefinance/i,
    'Hearth': /gethearth/i, 'Enhancify': /enhancify/i,
  },
  site_builder: {
    'Wix': /wix\.com|wixstatic/i, 'Squarespace': /squarespace/i, 'WordPress': /wp-content|wordpress/i, 'GoDaddy': /godaddy|secureserver\.net/i,
    'Weebly': /weebly/i, 'Duda': /dudaone|multiscreensite/i, 'Webflow': /webflow/i, 'Scorpion': /scorpion\.co/i, 'Hibu': /hibu/i,
  },
  analytics_ads: {
    'Google Analytics': /googletagmanager|google-analytics|gtag\(/i, 'Meta Pixel': /fbevents\.js|fbq\(/i,
    'CallRail': /callrail/i, 'Google Ads conversion': /googleadservices|AW-\d+/i,
  },
};

const SOCIAL_PATTERNS = {
  facebook: /facebook\.com\/(?!sharer|share|plugins|tr\b|dialog)[^"'\s?#]+/i,
  instagram: /instagram\.com\/[^"'\s?#/]+/i,
  linkedin: /linkedin\.com\/(company|in)\/[^"'\s?#]+/i,
  youtube: /youtube\.com\/(@|channel\/|c\/|user\/)[^"'\s?#]+/i,
  tiktok: /tiktok\.com\/@[^"'\s?#]+/i,
  x: /(?:twitter|x)\.com\/(?!share|intent)[A-Za-z0-9_]{2,}/i,
  nextdoor: /nextdoor\.com\/(pages|page)\/[^"'\s?#]+/i,
  yelp: /yelp\.com\/biz\/[^"'\s?#]+/i,
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(sentry|wixpress|example|domain|email|yourdomain|sentry-next)\.|^(u00|x22)|godaddy\.com$|wix\.com$|squarespace\.com$/i;

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
function normalizeUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).toString(); } catch { return null; }
}
const isSocialOnly = (u) => { const h = hostOf(u); return SOCIAL_HOSTS.some(s => h === s || h.endsWith('.' + s)); };

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: 12000, maxRedirects: 5, maxContentLength: 3_000_000, responseType: 'text',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    validateStatus: s => s < 400,
  });
  const type = String(res.headers['content-type'] || '');
  if (type && !type.includes('html')) throw new Error(`not html (${type})`);
  return { html: String(res.data || ''), finalUrl: res.request?.res?.responseUrl || url };
}

function pageText($) {
  $('script, style, noscript, svg, iframe, template').remove();
  const title = $('title').first().text().trim();
  const desc = $('meta[name="description"]').attr('content') || '';
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return { title, description: desc.trim(), text: text.slice(0, PAGE_TEXT_LIMIT) };
}

function detectSignals(htmlAll, textAll) {
  const found = {};
  for (const [group, sigs] of Object.entries(SIGNATURES)) {
    const hits = Object.entries(sigs).filter(([, re]) => re.test(htmlAll)).map(([name]) => name);
    if (hits.length) found[group] = [...new Set(hits)];
  }
  const t = textAll.toLowerCase();
  found.mentions = {
    emergency_24_7:  /24\/7|24 hours|24-hour|emergency service|after[- ]hours/.test(t),
    free_estimates:  /free (estimate|quote|inspection)/.test(t),
    financing:       /financing|finance options|0% apr|monthly payments/.test(t),
    maintenance_plan:/maintenance (plan|agreement|club|membership)|service (plan|agreement)|membership/.test(t),
    online_booking_language: /book (online|now)|schedule (online|now|service)|request (an )?appointment/.test(t),
    hiring:          /now hiring|we're hiring|careers|join our team/.test(t),
    family_owned:    /family[- ]owned|locally owned|owner[- ]operated/.test(t),
  };
  const years = [...textAll.matchAll(/©\s*(?:copyright\s*)?(\d{4})|copyright\s*©?\s*(\d{4})/gi)].map(m => Number(m[1] || m[2]));
  if (years.length) found.copyright_year = Math.max(...years);
  return found;
}

function extractEmails(html, siteHost) {
  const out = new Set();
  const $ = cheerio.load(html);
  $('a[href^="mailto:"]').each((_, a) => {
    const e = ($(a).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (e) out.add(decodeURIComponent(e).toLowerCase());
  });
  for (const m of html.match(EMAIL_RE) || []) out.add(m.toLowerCase());
  const list = [...out].filter(e => !BAD_EMAIL.test(e) && e.length < 80);
  // Same-domain addresses first, then personal-looking ones, then generic (info@, office@)
  const generic = /^(info|office|contact|hello|admin|service|sales|support|team|scheduling|billing|help)@/;
  return list.sort((a, b) => {
    const sa = (a.endsWith('@' + siteHost) ? 0 : 2) + (generic.test(a) ? 1 : 0);
    const sb = (b.endsWith('@' + siteHost) ? 0 : 2) + (generic.test(b) ? 1 : 0);
    return sa - sb;
  }).slice(0, 8);
}

function extractSocials(html) {
  const out = {};
  for (const [k, re] of Object.entries(SOCIAL_PATTERNS)) {
    const m = html.match(re);
    if (m) out[k] = 'https://' + m[0].replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/["'\\]+$/, '');
  }
  return out;
}

function pickInternalLinks($, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Map();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    let u; try { u = new URL(href, base); } catch { return; }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?)$/i.test(u.pathname)) return;
    u.hash = ''; u.search = '';
    const key = u.toString().replace(/\/$/, '');
    if (key === base.toString().replace(/\/$/, '')) return;
    const label = ($(a).text() || '') + ' ' + u.pathname;
    const rank = PAGE_HINTS.findIndex(re => re.test(label));
    if (rank === -1) return;
    if (!links.has(key) || links.get(key) > rank) links.set(key, rank);
  });
  return [...links.entries()].sort((a, b) => a[1] - b[1]).map(([u]) => u);
}

async function crawlSite(website) {
  const url = normalizeUrl(website);
  const site = { url, reachable: false, social_only: false, pages: [], emails: [], socials: {}, signals: {}, error: null };
  if (!url) { site.error = 'no website'; return site; }
  if (isSocialOnly(url)) { site.social_only = true; site.socials = extractSocials(url); site.error = 'website is a social/directory page'; return site; }

  let home;
  try { home = await fetchHtml(url); } catch (err) { site.error = `homepage unreachable: ${err.message}`; return site; }
  site.reachable = true;
  site.final_url = home.finalUrl;
  const host = hostOf(home.finalUrl);
  const $home = cheerio.load(home.html);
  const toVisit = pickInternalLinks($home, home.finalUrl).slice(0, Math.max(0, MAX_SITE_PAGES - 1));

  const raws = [home.html];
  site.pages.push({ url: home.finalUrl, ...pageText(cheerio.load(home.html)) });
  for (const link of toVisit) {
    try {
      const p = await fetchHtml(link);
      raws.push(p.html);
      site.pages.push({ url: link, ...pageText(cheerio.load(p.html)) });
    } catch { /* skip pages that fail */ }
  }

  // Trim combined text to budget, homepage first
  let budget = TOTAL_TEXT_LIMIT;
  for (const pg of site.pages) { pg.text = pg.text.slice(0, Math.max(0, budget)); budget -= pg.text.length; }

  const htmlAll = raws.join('\n');
  site.emails  = extractEmails(htmlAll, host);
  site.socials = extractSocials(htmlAll);
  site.signals = detectSignals(htmlAll, site.pages.map(p => p.text).join(' '));
  site.has_contact_form = /<form[\s\S]{0,4000}?(type=["']?email|name=["']?(email|phone|message))/i.test(htmlAll);
  return site;
}

// Google Place Details: up to 5 review texts + hours. Billed as
// "Place Details Enterprise + Atmosphere" ($25/1k after 1,000 free per month).
async function fetchGoogleDetails(placeId) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!FETCH_REVIEWS || !placeId || !key) return null;
  try {
    const res = await axios.get(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      timeout: 12000,
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'reviews,regularOpeningHours.weekdayDescriptions,googleMapsUri,editorialSummary,primaryTypeDisplayName',
      },
    });
    const d = res.data || {};
    return {
      maps_url: d.googleMapsUri || null,
      type: d.primaryTypeDisplayName?.text || null,
      summary: d.editorialSummary?.text || null,
      hours: d.regularOpeningHours?.weekdayDescriptions || null,
      // Reviewer names are left out on purpose; only rating, age and text matter here.
      reviews: (d.reviews || []).map(r => ({
        rating: r.rating,
        when: r.relativePublishTimeDescription,
        text: (r.text?.text || r.originalText?.text || '').slice(0, 1200),
      })).filter(r => r.text),
    };
  } catch (err) {
    return { error: `place details failed: ${err.response?.status || ''} ${err.message}` };
  }
}

async function researchLead(lead) {
  const [site, google] = await Promise.all([crawlSite(lead.website), fetchGoogleDetails(lead.google_place_id)]);
  return {
    collected_at: new Date().toISOString(),
    business: {
      company: lead.company, industry: lead.industry, city: lead.city, state: lead.state,
      phone: lead.phone, website: lead.website, rating: lead.rating, review_count: lead.review_count,
      address: lead.address,
    },
    site,
    google,
  };
}

module.exports = { researchLead, crawlSite, extractEmails, extractSocials, detectSignals, isSocialOnly };
