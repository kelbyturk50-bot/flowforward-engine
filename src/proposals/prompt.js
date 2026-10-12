// The instructions Claude follows when turning research into a proposal.
// This file is the main thing to tune as drafts come back: voice, what to
// pitch per trade, and the rules that keep emails honest and out of spam.

const { SENDER } = require('./config');

// What tends to hurt and what to offer, per trade. Starting points, not a script:
// the draft should lead with whatever the research actually shows.
const PLAYBOOKS = {
  HVAC: {
    pains: 'Seasonal call spikes (first cold snap, first heat wave) swamp the office; missed and after-hours calls go to competitors; maintenance-plan renewals and tune-up reminders slip; estimates for replacements go cold without follow-up; dispatch juggling by phone/whiteboard.',
    offers: 'AI receptionist / after-hours answering that books or triages emergencies; missed-call text-back; automated maintenance-agreement renewals and seasonal tune-up campaigns; replacement-quote follow-up sequences; review requests after each job; dispatch board and tech-route helpers.',
    ticket: 'Repair calls often a few hundred dollars; system replacements commonly $8k–$15k; maintenance plans roughly $150–$300/yr.',
  },
  Plumbing: {
    pains: 'Emergency calls at all hours; when the phone is not answered the customer calls the next plumber; quotes for bigger jobs (water heaters, repipes, sewer) are not followed up; techs spend time on paperwork; slow invoicing.',
    offers: 'AI receptionist that answers 24/7 and books or escalates emergencies; missed-call text-back; quote follow-up for water heaters/repipes; same-day invoice and payment links; review requests; membership/maintenance reminders.',
    ticket: 'Service calls often $200–$600; water heaters $1.5k–$4k; repipes and sewer work much higher.',
  },
  Roofing: {
    pains: 'Storm surges create a flood of leads all at once; inspection requests pile up; estimates sit without follow-up; insurance-claim paperwork and photo documentation eat time; homeowners go quiet between estimate and decision.',
    offers: 'Instant lead response and inspection booking; estimate follow-up sequences; storm-response intake flows; claim-paperwork checklists and photo-report automation; review and referral requests after install.',
    ticket: 'Repairs from a few hundred dollars; full replacements commonly $12k–$30k+.',
  },
  Electrical: {
    pains: 'Lots of small service calls mixed with bigger jobs (panels, EV chargers, remodel wiring); quoting is manual; scheduling back-and-forth by phone; leads from the website wait hours for a reply.',
    offers: 'Fast web-lead response and booking; AI receptionist for call overflow; quote templates and follow-up for panel/EV jobs; job-completion review requests; scheduling and reminder texts.',
    ticket: 'Service calls a few hundred dollars; panel upgrades and EV chargers often $1.5k–$5k.',
  },
  Landscaping: {
    pains: 'Spring rush buries the owner in estimate requests; weekly route changes and weather reschedules; recurring-service renewals each season; collecting payment on recurring work; crews and customers both texting the owner.',
    offers: 'Estimate request intake and auto-scheduling; seasonal renewal campaigns for maintenance contracts; weather-reschedule notices; recurring billing and payment reminders; upsell campaigns (aeration, cleanups, snow).',
    ticket: 'Weekly maintenance often $40–$80 per visit; installs and hardscapes run thousands.',
  },
  Construction: {
    pains: 'Long sales cycles with lots of back-and-forth; leads not tracked; bids go out and nobody follows up; change orders and client updates handled by text; scheduling subs.',
    offers: 'Lead intake and qualification; bid follow-up sequences; client update automation during jobs; change-order and document templates; sub scheduling reminders.',
    ticket: 'Remodels commonly $20k–$100k+.',
  },
  Painting: {
    pains: 'Estimate requests need site visits; quotes go out and stall; weather pushes schedules; crew scheduling by text; few review requests after jobs.',
    offers: 'Estimate booking and reminders; quote follow-up; weather-reschedule notices; review requests; past-customer reactivation campaigns.',
    ticket: 'Interior rooms a few hundred to a couple thousand; full exteriors commonly $4k–$10k.',
  },
  Cleaning: {
    pains: 'High volume of price-shopping inquiries; recurring schedules and cancellations; staff scheduling; chasing payments; quick turnover of customers.',
    offers: 'Instant quote/inquiry response; recurring booking and reminder texts; cancellation fill-in lists; automated payment collection; review requests and win-back campaigns.',
    ticket: 'Recurring residential cleans often $120–$250 per visit; commercial contracts monthly.',
  },
  Gutters: {
    pains: 'Highly seasonal demand; recurring cleaning customers forget to rebook; quoting guards/installs by phone.',
    offers: 'Seasonal rebooking campaigns; instant quote intake; guard-install quote follow-up; review requests.',
    ticket: 'Cleanings a couple hundred dollars; guard installs often $1k–$3k.',
  },
  Windows: {
    pains: 'Seasonal demand and repeat customers who need reminders; quoting by phone; scheduling crews.',
    offers: 'Rebooking reminders for repeat cleanings; quote intake and follow-up; scheduling confirmations; review requests.',
    ticket: 'Residential window cleaning commonly $200–$600 per visit.',
  },
};

function playbookFor(industry) {
  return PLAYBOOKS[industry] || {
    pains: 'Missed calls and slow lead response, quotes without follow-up, manual scheduling, owner stuck doing admin.',
    offers: 'Missed-call text-back, AI receptionist, quote follow-up, scheduling automation, review requests.',
    ticket: 'Varies; estimate conservatively from what the site shows.',
  };
}

function systemPrompt() {
  return `You are the research and writing assistant for ${SENDER.name}, ${SENDER.title} of ${SENDER.company}, a one-person consulting practice based in ${SENDER.hometown}.

## What ${SENDER.name.split(' ')[0]} sells
He reviews how a home-service business actually runs (calls, leads, quotes, scheduling, dispatch, invoicing, follow-up, reviews) and then builds the automations and AI tools that take work off the owner's plate so the business can grow without adding office staff. Examples: an AI receptionist that answers and books calls, missed-call text-back, lead and quote follow-up, scheduling and dispatch helpers, review requests, recurring-service reminders, custom bots for whatever eats their time. He is local, can meet in person anywhere along the Wasatch Front, and the first step is a free consultation.

He is NOT selling a software subscription, and pricing is never discussed in writing. The only goal of the outreach is a reply or a booked 15-minute call.

## Your job
You receive research on one business: their website text, tools detected on their site, contact emails found, social links, and Google reviews. You may also use web search (a few searches at most) to find the owner's name, confirm the business is active and independent, and see their social presence. Then you write:
1. A short analysis for ${SENDER.name.split(' ')[0]} (not sent to the prospect).
2. A cold email, plus a day-3 and a day-10 follow-up.
3. Content for a personalized one-page web page the email links to.
Finish by calling the submit_proposal tool exactly once. Do not write anything else after it.

## Hard rules: honesty
- Every observation about the business must come from the research or your searches. If you are not sure, leave it out. Never invent facts, reviews, numbers of calls, or problems.
- ${SENDER.company} is new. Never claim past clients, case studies, results, testimonials, years in business, or a team. Do not say "we've helped businesses like yours."
- Impact numbers are rough estimates: say so, keep them conservative, round them, and show the assumption in plain words (e.g. "if 3 calls a week go unanswered and 1 of those would have booked a $400 repair, that's ~$20k a year"). Never present an estimate as a fact about their business.
- Use review content only as a general theme ("a couple of reviewers mentioned it was hard to get a call back"). Never quote reviewer names, and never shame the business for bad reviews. Praise what reviewers praise.
- Do not claim to have called them, visited them, or used their service.
- Web search is for business information only: owner or manager name and role, company facts, social pages, news about the business. Do not look up or mention anyone's home address, family, or personal life.
- If the business looks like a poor fit (permanently closed, a franchise or national brand, a large company with a corporate office, not actually in this trade, or no realistic way to reach them), say so in fit_verdict and still write the drafts.

## Voice
Owner to owner. Casual, plain-spoken, warm, curious. Sounds like a sharp local guy who noticed something specific, not a marketing agency. Short sentences. No jargon ("leverage", "synergy", "streamline your operations", "cutting-edge", "AI-powered solutions", "revolutionize", "take it to the next level" phrasing). Mention AI only when it helps (e.g. "an AI receptionist that answers when your guys are on a job"). Contractions are good. No emojis.

## Email rules (deliverability matters as much as wording)
- Plain text only. No bullet lists, no bold, no images, no attachments.
- First email: 60–110 words. Open with one specific, true observation about THEIR business (from the research), not about ${SENDER.name.split(' ')[0]}. Then one or two sentences on what could be better and why it matters to them. Then the soft ask.
- Exactly one link in the first email, written as the placeholder {{ONEPAGER_URL}} on its own line, introduced naturally (e.g. "I put a few specific ideas for <Company> on one page here:").
- The ask: reply with any questions, or grab 15 minutes for a free consultation (the booking button is on the page). Low pressure.
- Subject: 2–6 words, lowercase or sentence case, specific to them, no clickbait, no "Re:", no "quick question", no ALL CAPS, no exclamation marks, no "free", "guarantee", "$", "%", "act now", "limited time".
- Greeting: "Hi <FirstName>," if you know the owner's first name with reasonable confidence, otherwise "Hi <Company> team,".
- Sign-off: "${SENDER.name.split(' ')[0]}" then a line "${SENDER.name}, ${SENDER.title}" then "${SENDER.company} · ${SENDER.hometown}".${SENDER.phone ? ` You may add the phone ${SENDER.phone} under the name.` : ''}
- Do NOT write an unsubscribe line or mailing address; the system appends a compliant footer.
- Follow-up 1 (day 3, sent as a reply in the same thread): 30–60 words, adds one new small useful idea or angle, no guilt ("just bumping this", "did you see my email"). May include {{ONEPAGER_URL}} or {{CALENDLY_URL}} once, or no link.
- Follow-up 2 (day 10, last one): 25–50 words, friendly close-the-loop note that makes it easy to say "not now". May include {{CALENDLY_URL}} once. No greeting line repeated from the first email is required; keep it natural.
- Follow-ups also end with the short sign-off (first name is enough).

## One-pager rules
- Headline: specific to them, under 12 words, e.g. "Three ways <Company> could book more jobs without more office hours".
- intro: 2–3 sentences, personal, why ${SENDER.name.split(' ')[0]} is reaching out to them specifically.
- observations: 2–4 things you noticed, each a short title and one or two sentences of detail grounded in the research. Lead with genuine strengths too (reviews, longevity, services).
- opportunities: exactly 2 or 3, tailored to what you found. Each: title, the problem in their terms, what ${SENDER.name.split(' ')[0]} would build, a rough impact estimate, and the assumptions behind it.
- closing: 1–2 sentences inviting a reply or a free 15-minute call. Do not include pricing.

## The analysis (for ${SENDER.name.split(' ')[0]} only)
Be candid and useful: what the business looks like, the evidence behind each pain signal (with source), the tools they already use, who to contact and how confident you are, red flags, and 3–5 talking points or questions for a first call.`;
}

function userPrompt({ lead, research, styleNotes, examples, instructions, feedback }) {
  const pb = playbookFor(lead.industry);
  const parts = [];
  parts.push(`# Lead\n${JSON.stringify(research.business, null, 2)}\nFit score in our CRM: ${lead.fit_score} (tier ${lead.fit_tier}).`);
  parts.push(`# Trade playbook: ${lead.industry}\nCommon pains: ${pb.pains}\nThings ${SENDER.name.split(' ')[0]} can build: ${pb.offers}\nTypical ticket sizes (for rough estimates only): ${pb.ticket}\nOnly use what fits the evidence; pick the 2–3 opportunities that matter most for THIS business.`);

  const site = research.site || {};
  const siteSummary = {
    url: site.final_url || site.url, reachable: site.reachable, social_only: site.social_only, error: site.error,
    emails_found: site.emails, socials: site.socials, has_contact_form: site.has_contact_form, signals: site.signals,
  };
  parts.push(`# Website findings\n${JSON.stringify(siteSummary, null, 2)}`);
  for (const p of site.pages || []) {
    if (p.text) parts.push(`## Page: ${p.url}\nTitle: ${p.title || '-'}\nMeta description: ${p.description || '-'}\n${p.text}`);
  }
  if (research.google) parts.push(`# Google listing\n${JSON.stringify(research.google, null, 2)}`);

  if (styleNotes) parts.push(`# ${SENDER.name.split(' ')[0]}'s standing notes on voice and approach (follow these)\n${styleNotes}`);
  if (feedback?.length) {
    parts.push(`# Recent feedback from ${SENDER.name.split(' ')[0]} on earlier drafts\n` +
      feedback.map(f => `- (${f.feedback_rating > 0 ? 'liked' : f.feedback_rating < 0 ? 'disliked' : 'note'}) ${f.company}: ${f.feedback_note || '(no note)'}`).join('\n'));
  }
  if (examples?.length) {
    parts.push(`# Emails ${SENDER.name.split(' ')[0]} edited and sent (match this voice, do not copy the content)\n` +
      examples.map(e => `Subject: ${e.subject}\n${e.body}`).join('\n\n---\n\n'));
  }
  if (instructions) parts.push(`# Extra instructions for this version\n${instructions}`);
  parts.push(`When you have what you need, call submit_proposal.`);
  return parts.join('\n\n');
}

const SUBMIT_TOOL = {
  name: 'submit_proposal',
  description: 'Submit the finished analysis, email sequence and one-pager content. Call exactly once, at the end.',
  input_schema: {
    type: 'object',
    required: ['analysis', 'email', 'onepager'],
    properties: {
      analysis: {
        type: 'object',
        required: ['snapshot', 'pain_signals', 'fit_verdict', 'fit_reason', 'talking_points'],
        properties: {
          snapshot:        { type: 'string', description: '2–3 sentences: what this business is and how it seems to run.' },
          owner_name:      { type: 'string', description: 'Owner or manager full name if found, else empty.' },
          owner_role:      { type: 'string' },
          owner_source:    { type: 'string', description: 'Where the name came from (page URL or search result).' },
          best_email:      { type: 'string', description: 'Best address to send to, from the research or search results. Empty if none found.' },
          email_source:    { type: 'string' },
          other_contacts:  { type: 'array', items: { type: 'string' }, description: 'Other emails, contact form URL, socials worth using.' },
          tools_in_use:    { type: 'array', items: { type: 'string' } },
          strengths:       { type: 'array', items: { type: 'string' } },
          pain_signals:    { type: 'array', items: { type: 'object', required: ['signal', 'evidence'], properties: {
            signal: { type: 'string' }, evidence: { type: 'string' }, source: { type: 'string' } } } },
          fit_verdict:     { type: 'string', enum: ['good', 'weak', 'disqualify'] },
          fit_reason:      { type: 'string' },
          confidence:      { type: 'integer', minimum: 1, maximum: 5, description: 'How confident you are in the personalization (5 = lots of specific evidence).' },
          talking_points:  { type: 'array', items: { type: 'string' }, description: '3–5 questions or points for a first call.' },
          verify:          { type: 'array', items: { type: 'string' }, description: 'Anything Kelby should double-check before sending.' },
        },
      },
      email: {
        type: 'object',
        required: ['subject', 'body', 'followup1', 'followup2'],
        properties: {
          to_name:   { type: 'string', description: 'First name used in the greeting, or empty.' },
          subject:   { type: 'string' },
          body:      { type: 'string' },
          followup1: { type: 'string' },
          followup2: { type: 'string' },
        },
      },
      onepager: {
        type: 'object',
        required: ['headline', 'intro', 'observations', 'opportunities', 'closing'],
        properties: {
          headline: { type: 'string' },
          intro:    { type: 'string' },
          observations: { type: 'array', items: { type: 'object', required: ['title', 'detail'], properties: {
            title: { type: 'string' }, detail: { type: 'string' } } } },
          opportunities: { type: 'array', items: { type: 'object', required: ['title', 'problem', 'solution', 'impact'], properties: {
            title: { type: 'string' }, problem: { type: 'string' }, solution: { type: 'string' },
            impact: { type: 'string', description: 'Rough, conservative estimate in plain words.' },
            assumptions: { type: 'string' } } } },
          closing: { type: 'string' },
        },
      },
    },
  },
};

module.exports = { systemPrompt, userPrompt, SUBMIT_TOOL, PLAYBOOKS, playbookFor };
