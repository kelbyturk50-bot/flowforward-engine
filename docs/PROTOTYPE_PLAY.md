# Prototype Play: branded agent prototypes (Scout)

**Status:** Product spec. Summit's team builds. Scout owns selection, positioning, and build order.
**Locked GTM (unchanged):** residential HVAC with 2–15 trucks, not on ServiceTitan, in Utah first. Plumbing is secondary. Pest control is out. Kelby is the only one who contacts prospects, by his own email and phone. Bots never contact anyone. No cold SMS. The customer owns the workflow, data, and accounts (export anytime, no termination fee). Pilot #1 wedge is **Unsold-Estimate Recovery** (#21/#22). Kill rule and proof gate: see `flowforward-wedge-reopen.md`.

**What it is:** a private, clickable prototype of a FlowForward agent in the prospect's brand, running on synthetic data. Every screen carries the watermark **"PROTOTYPE, not live. FlowForward can make this real in days."** It is baked into the render, so neither the viewer nor the prospect can remove or hide it. Kelby shows it in his own-name demo. It is the top rung of the offer ladder, not a product.

### Builder guardrails (binding for Summit's team)
- **Nothing real goes out.** No real email, SMS, or calls from any prototype screen. No Twilio.
- **No live calls from the generator.** No live discovery runs, and no Places, Anthropic, or Gmail calls. Inputs are cached prospect data plus fixtures.
- **No real prospect logos (Kelby, Oct 16).** Previews use the company name and colors only, entered by hand or from fixtures. Fetching logos or brand assets from a prospect's site is not approved, and logo upload is off too. Reopening it needs Kelby's yes plus the SSRF fix (#30) and Warden review.
- **Flag:** `FF_PROTOTYPE_GALLERY` gates every prototype route and generator. It defaults to **OFF in prod**.
- **No Railway or Vercel setting or env changes.**
- **Tagged test data only,** per the pre-prod policy. Prototype rows and events are tagged, cleaned up after, and the proof is posted on the PR.
- **Links expire after 14 days.**
- **No ROI or close-rate promises,** anywhere: copy, demo, or proposal. Use conditional wording ("could", "shops like yours often").
- Builds follow branch → PR → gates (see PLAYBOOK): Ochre reviews UI, and Warden reviews token/link auth.

---

## (a) Selection rubric: signal → gap → prototype

### Hard rules for the score path (same as F-002/F-003)
- **Cache only.** Read `prospects.research` (JSONB), `prospects.fsm_detected` (PR #29), and the prospect row. **No HTTP** in `computeFit`/`rescore`/the prototype picker. **No new Places query types and no Place Details calls** on this path. If a signal is unknown, it scores 0 and is never a penalty.
- Runs as a pure function next to F-003: `pickPrototypes(prospect) → [{agent, score, reasons}]`. It only ranks. It never triggers a build or any contact.

### Signal catalog

`Cache` = already written by `src/proposals/research.js` / PR #29. `New-derived` = computed from data already cached, with no fetch. `New-collect` = needs a research change, so it waits for its own spec.

| id | Observable signal | Source path | Status |
|---|---|---|---|
| `has_site` | Real website (not social/listing) | `website` + `SOCIAL_HOSTS` | Cache |
| `booking_widget` | Online booking present | `research.signals.online_booking[]` | Cache |
| `booking_language` | "Book online / request appointment" text | `research.signals.mentions.online_booking_language` | Cache |
| `chat_widget` | Chat/text widget (Podium, Hatch, GHL…) | `research.signals.chat_or_text_widget[]` | Cache |
| `review_tool` | Review tool (NiceJob, Birdeye, Podium…) | `research.signals.reviews_tools[]` | Cache |
| `fsm` | FSM detected (Jobber/HCP/ServiceTitan/…) | `fsm_detected` (PR #29), else `research.signals.field_service_software[]` | Cache |
| `financing` | Financing language or lender widget | `mentions.financing` / `signals.financing[]` | Cache |
| `free_estimate` | "Free estimate/quote" language | `mentions.free_estimates` | Cache |
| `maint_plan` | Maintenance plan/club page or language | `mentions.maintenance_plan` | Cache |
| `emergency_247` | 24/7 / after-hours claim | `mentions.emergency_24_7` | Cache |
| `hours` | Weekday hours (closed evenings/weekends) | `research.place.hours` (only if already cached) | Cache (when researched) |
| `review_count`, `rating` | Size proxy and reputation (sweet spot 25–200, per F-002) | prospect row | Cache |
| `franchise` | National brand name match | `FRANCHISE_PATTERNS` on `company` | Cache |
| `rv_missed_call` | Review text mentions "no answer / voicemail / couldn't reach / never called back" | regex over cached `research.reviews[].text` (≤5) | New-derived |
| `rv_slow_quote` | Review text mentions "slow quote / never got the estimate / never followed up" | same | New-derived |
| `rv_scheduling` | Review text mentions "hard to schedule / no-show / late / rescheduled" | same | New-derived |
| `contact_form_only` | Has form/email but no booking, chat, or FSM portal | derived from the rows above | New-derived |
| `quote_form` | Dedicated estimate/quote request page | page hints already crawled (`/estimate|quote/`); needs a flag written at research time | New-collect |
| `truck_count` | Fleet size | not observable cheaply. Use `review_count` as the proxy (25–200 is the sweet spot, per F-002) | Not collected (proxy only) |

### Points per agent type (0–100 after clamp)

Positive points add up. A signal that is unknown adds nothing. "Gap" means the signal shows the agent would fill a hole.

| Signal | Estimate follow-up | Speed-to-lead (web) | Receptionist / call answering | Scheduling | Review requests | Maint-plan renewal | Dispatch | Bookkeeping |
|---|---|---|---|---|---|---|---|---|
| `free_estimate` | +25 | +10 | | | | | | |
| `financing` | +20 | +5 | | | | | | |
| `rv_slow_quote` | +25 | +10 | | | | | | |
| `rv_missed_call` | | +15 | +30 | | | | | |
| `rv_scheduling` | | | +5 | +25 | | | +15 | |
| no `booking_widget` and no `booking_language` | | +10 | +5 | +25 | | | | |
| `contact_form_only` | +5 | +25 | | +10 | | | | |
| no `chat_widget` | | +15 | +10 | | | | | |
| no `emergency_247` or `hours` closed evenings | | +5 | +20 | | | | | |
| no `review_tool` | | | | | +30 | | | |
| `review_count` < 75 and `rating` ≥ 4.3 | | | | | +20 | | | |
| `maint_plan` | +5 | | | | | +35 | | |
| `fsm` ∈ {Jobber, Housecall Pro} | +10 | +5 | | | +5 | +10 | | |
| `fsm` = none detected | +5 | +5 | +5 | +10 | | | +10 | +5 |
| `review_count` 25–200 | +10 | +10 | +10 | +10 | +10 | +10 | +5 | +5 |
| `review_count` > 200 | +5 | +5 | +10 | | | +10 | +15 | |
| Industry = HVAC | +10 | +5 | +5 | +5 | +5 | +10 | +5 | |

### Tie-breaks (in order)
These numbered rules are authoritative and apply in order. `tieRank` is only the final fallback after rules 1–4 are still tied. Each agent type carries `costTier` (1 email-only, 2 needs FSM integration, 3 needs telephony). Rule 1 sorts **prospects** (queue and gallery priority), because industry is fixed within one prospect. Rules 2–4 pick among agent types for a single prospect. Own-it fit comes from a per-FSM config list of agents the FSM already bundles cheaply (starting with Jobber → receptionist).

**Input rules:** `fsm_detected` wins, and research signals are used only when it's empty. A state of `Utah` or `UT` (any case) counts as Utah, and a missing state parks the lead as unknown. Franchise names use word-boundary matching. Pest, franchise and out-of-state rules live in config.

**Cost tier per agent:** estimate follow-up 1, speed-to-lead 1, review requests 1, scheduling 2, maintenance-plan renewal 2, dispatch 2, bookkeeping 2 (needs an accounting-system integration, not an FSM; the same tier by cost), receptionist 3.

**Unknown state:** no prototype. The lead is parked until its state is known, matching the out-of-state park rule. #46 must match.

1. **HVAC beachhead bias.** HVAC beats plumbing, and plumbing beats the rest. This sorts prospects (queue and gallery priority) and is not a fit-score change (Summit: no plumbing score tweak).
2. **Estimate follow-up wins ties.** It is Pilot #1 and the only rung with an `estimate_recovered` proof path.
3. **Cheapest to make real:** email-only beats needing an FSM integration, which beats needing telephony (#12 is blocked).
4. **Own-it fit:** prefer agents the FSM does not already include cheaply (e.g. a low-cost Jobber add-on makes receptionist a weak own-it pitch for Jobber shops).

### Disqualifiers and caps
- **Pest control:** no prototype (out of GTM).
- **Franchise name match:** no prototype. **This is intentional for v1 (Scout).** Franchises run on corporate systems and make weak buyers. It is stricter than F-004's tier-B cap on purpose: a lead can still be scored, but it gets no prototype.
- **ServiceTitan detected:** only *light* prototypes (estimate follow-up summary view, review requests). No receptionist, scheduling, or dispatch, because ST already sells those natively. Tracked with the F-004 tier-B cap.
- **Score < 40 on every agent type** (`minScore: 40`): no prototype. This is a hard floor with no manual override.
- **Bookkeeping:** never auto-picked. It is offered only when the prospect asks for it in a live conversation.
- **Out of state:** park until the Utah proof gate is met.
- Pick **at most 2** prototypes per prospect. The top one is the demo; the second is a "next step" mention.

### Drop-in config (pseudo-JSON for `src/scoring/prototypes.config.js`)

```jsonc
{
  "version": 1,
  "rules": { "cacheOnly": true, "httpOnScorePath": 0, "newPlacesQueries": 0, "unknownSignal": 0, "maxPicks": 2, "minScore": 40 },
  "disqualify": [
    { "if": "industry == 'Pest Control'", "reason": "out of GTM" },
    { "if": "franchise", "reason": "corporate systems; weak buyer" },
    { "if": "state not in ['Utah','UT'] (case-insensitive)", "action": "park", "reason": "out of state until Utah proof gate" },
    { "if": "state missing", "action": "park", "reason": "unknown state" }
  ],
  "ownItWeak": { "Jobber": ["receptionist"] },
  "restrict": [
    { "if": "fsm == 'ServiceTitan'", "allow": ["estimate_followup", "review_requests"] }
  ],
  "neverAutoPick": ["bookkeeping"],
  "signals": {
    "free_estimate":   { "path": "research.signals.mentions.free_estimates", "status": "cache" },
    "financing":       { "path": ["research.signals.mentions.financing", "research.signals.financing"], "status": "cache" },
    "maint_plan":      { "path": "research.signals.mentions.maintenance_plan", "status": "cache" },
    "emergency_247":   { "path": "research.signals.mentions.emergency_24_7", "status": "cache" },
    "booking_widget":  { "path": "research.signals.online_booking", "status": "cache" },
    "booking_language":{ "path": "research.signals.mentions.online_booking_language", "status": "cache" },
    "chat_widget":     { "path": "research.signals.chat_or_text_widget", "status": "cache" },
    "review_tool":     { "path": "research.signals.reviews_tools", "status": "cache" },
    "fsm":             { "path": ["fsm_detected", "research.signals.field_service_software"], "status": "cache" },
    "rv_missed_call":  { "derive": "regex(research.reviews[].text, /no answer|voicemail|couldn'?t reach|never (called|call) back|didn'?t call back/i)", "status": "new-derived" },
    "rv_slow_quote":   { "derive": "regex(research.reviews[].text, /never (got|received) (a|the|my) (quote|estimate)|slow (to )?quote|never followed up|no follow[- ]?up/i)", "status": "new-derived" },
    "rv_scheduling":   { "derive": "regex(research.reviews[].text, /no[- ]show|hard to schedule|reschedul|showed up late|never showed/i)", "status": "new-derived" },
    "contact_form_only": { "derive": "has_site && !booking_widget && !chat_widget && !fsm", "status": "new-derived" },
    "quote_form":      { "status": "new-collect", "note": "needs research.js flag; separate spec" }
  },
  "agents": {
    "estimate_followup": { "free_estimate": 25, "financing": 20, "rv_slow_quote": 25, "contact_form_only": 5, "maint_plan": 5, "fsm_jobber_hcp": 10, "fsm_none": 5, "size_sweet": 10, "size_big": 5, "hvac": 10, "costTier": 1, "tieRank": 1 },
    "speed_to_lead":     { "free_estimate": 10, "financing": 5, "rv_slow_quote": 10, "rv_missed_call": 15, "no_booking": 10, "contact_form_only": 25, "no_chat": 15, "closed_after_hours": 5, "fsm_jobber_hcp": 5, "fsm_none": 5, "size_sweet": 10, "size_big": 5, "hvac": 5, "costTier": 1, "tieRank": 2 },
    "receptionist":      { "rv_missed_call": 30, "rv_scheduling": 5, "no_booking": 5, "no_chat": 10, "closed_after_hours": 20, "fsm_none": 5, "size_sweet": 10, "size_big": 10, "hvac": 5, "costTier": 3, "tieRank": 3 },
    "scheduling":        { "rv_scheduling": 25, "no_booking": 25, "contact_form_only": 10, "fsm_none": 10, "size_sweet": 10, "hvac": 5, "costTier": 2, "tieRank": 4 },
    "review_requests":   { "no_review_tool": 30, "small_good_rating": 20, "fsm_jobber_hcp": 5, "size_sweet": 10, "hvac": 5, "costTier": 1, "tieRank": 5 },
    "maint_renewal":     { "maint_plan": 35, "fsm_jobber_hcp": 10, "size_sweet": 10, "size_big": 10, "hvac": 10, "costTier": 2, "tieRank": 6 },
    "dispatch":          { "rv_scheduling": 15, "fsm_none": 10, "size_sweet": 5, "size_big": 15, "hvac": 5, "costTier": 2, "tieRank": 7 },
    "bookkeeping":       { "fsm_none": 5, "size_sweet": 5, "costTier": 2, "tieRank": 8 }
  }
}
```

**Tests Canyon should add:** each agent's top fixture picks the right agent; an unknown or empty `research` gives no picks and no throw; ST restricts the picks; pest and franchise give none; the HTTP mock asserts 0 calls; the Places catalog count is unchanged.

---

## (b) Positioning and GTM

### Narrative (Kelby, own name)
> "I built what your follow-up would look like if it ran itself, in your brand, on fake data. It's a prototype, it says so on every screen. If you like it, we make it real in a couple of weeks, on your email and your accounts. You own it. Walk away anytime and take everything with you."

The lead is the **outcome**, not the AI. A Utah replacement install is a big-ticket job (wedge memo §2), so if even one stalled estimate is recovered, it could cover the build. Never promise that it will.

### Offer ladder
1. **Free branded prototype.** Private link, synthetic data, watermark. Shown live by Kelby.
2. **Paid MVP build.** One agent, real data, the customer's own mailbox/accounts (#22 scope; intake is CSV-only as the working default until Kelby decides; Warden review, kill switches, Kelby approves any paid inbox).
3. **Hosting and maintenance plan.** Monitoring, fixes, small changes. Monthly, cancel anytime, export included.
4. **Consulting.** Hourly or a small block, for the next workflow or an audit.

### Pricing
The four packages are Free branded prototype, MVP build, Hosting and maintenance plan, and Consulting. Pricing is shared after initial outreach. The first build may be discounted in exchange for a case study.

Market research (qualitative only; public vendor and agency pages, so treat as directional, and this doc quotes no figures from them): [Iternal](https://iternal.ai/ai-consulting-for-small-business), [Agents Chef](https://www.agentschef.com/pricing), [Taskip](https://taskip.net/ai-automation-agency-pricing/), [Ascend Intuition](https://ascend-intuition.com/blog/ai-agent-cost-small-business), [Working Theory](https://workingtheoryai.com/insights/what-a-small-business-automation-consultant-does/), [ServiceAgent](https://serviceagent.ai/blogs/hatch-pricing/), [Jobber](https://help.getjobber.com/en/articles/receptionistpowered-by-jobber-ai/), [Milicevic](https://lazar-milicevic.com/blog/hiring-an-ai-automation-consultant-for-your-small-business), [Jahanzaib](https://www.jahanzaib.ai/blog/ai-automation-consultant-hourly-rate).

Why this sits at the low end of the market: it is a beachhead for 2–15-truck owners, and the proof gate (1 paid build) matters more than margin right now. Kelby approved a first-build discount in exchange for a case study.

### Objection handling
1. **"Is this real or a mockup?"** It's a prototype on fake data, and it says so on every screen. The real version uses your inbox and your estimates. That's the paid build.
2. **"Jobber/HCP already sends quote reminders."** Jobber sends up to two automatic reminders, and custom sequences need Grow. This runs 3–4 touches from your own mailbox, stops when they reply, and tells you which estimates came back.
3. **"I don't want AI talking to my customers."** It drafts in your voice, from your email, on a schedule you approve. You can turn it off with one switch. Nothing goes out by SMS unless you set that up later.
4. **"What if I stop paying?"** You own the accounts and data. Export anytime, no termination fee.
5. **"Too expensive."** A Utah replacement install is a big-ticket job. Many shops have some open estimates that never got a follow-up, and if even one came back, it could cover the cost. No promises. The audit shows your real numbers first.
6. **"I'm too busy to set it up."** Setup is a CSV or forwarding your estimate emails. About an hour of your time.
7. **"Will it spam people or hurt my reviews?"** Max 3–4 touches, stops on reply, and every message comes from you.
8. **"Where did this branding come from?"** It's just your company name and colors, entered by hand. Nothing was pulled from your site, and it's a private link only you have. We take it down the moment you ask.
9. **"We already have an office manager."** It's her follow-up list, worked automatically. She handles the replies, not the chasing.
10. **"I'm on ServiceTitan."** ST has its own unsold-estimate agent. Use it. We'd only add value at the edges.

### CRM proof metrics (events, no free-text PII; ids and enums only)
`prototype_generated`, `prototype_link_issued`, `prototype_viewed` (token id, agent_type, screen), `prototype_cta_clicked` (cta enum), `prototype_takedown_requested`, `call_booked`, `audit_completed` (open_estimates_bucket enum), `mvp_proposed`, `mvp_sold` (agent_type, price_band enum), `mvp_live`, `estimate_recovered` (amount_band enum), `hosting_started`, `hosting_cancelled`, `consulting_booked`. Funnel to watch: viewed → cta → call_booked → mvp_sold.

### Ethics line (non-negotiable; every prototype)
- The watermark **"PROTOTYPE, not live. FlowForward can make this real in days."** appears on every screen, including in screenshots. It is baked into the render and can't be removed.
- `noindex,nofollow`, plus robots disallow. Tokenized links (≥16 random bytes, per wedge memo rules), rate-limited, expiring after 14 days.
- Never imply they are a client. No "trusted by" or client lists using their name.
- No fake reviews or testimonials, and no made-up customer quotes.
- **No ROI or close-rate promises.** Use conditional wording only.
- Their name and colors (no logo) appear **only** in the private prototype shown to them, never in our marketing.
- **Synthetic data only.** No real customer names, phone numbers, or addresses, even if public.
- Take it down on request, the same day. Log `prototype_takedown_requested`.
- Bots generate prototypes. Only Kelby shares the link.

---

## (c) Build-first order

1. **Estimate follow-up.** It's Pilot #1, has the biggest dollars per event, works email-only with no Twilio cost, the demo is visceral, and it's the only path to `estimate_recovered`.
2. **Speed-to-lead / web lead response.** The runner-up wedge. Web-form-first is buildable now, and the contact-form-only signal is common and observable.
3. **Call answering / receptionist.** The pain is strong and shows up in reviews (missed calls), but the space is crowded (a low-cost Jobber add-on) and the real version needs telephony (#12 blocked). Build it as a prototype first.
4. **Scheduling.** A clear "no booking widget" signal, but FSMs bundle online booking cheaply (HCP Basic), so own-it is weak. Good as a visual demo.
5. **Review requests.** Cheap to build and easy to spot, but a low-cost review add-on (NiceJob) covers the same job and FSMs include it. Good as an add-on, not a lead.
6. **Maintenance-plan renewal.** High value when `maint_plan` exists, but it needs agreement data from the FSM, so it's a second-build upsell.
7. **Dispatch.** The pain belongs to bigger shops and the money already goes to the FSM. It's hard to demo honestly on synthetic data.
8. **Bookkeeping: LOW.** High trust and accuracy risk (money, taxes, the CPA relationship), no observable public signal, needs access to sensitive financial accounts, and it's off-wedge. Offer it only when asked.

## Decisions and pending items
- **Decided (Scout):** franchises get no prototype in v1. Hard floor at minScore 40, no override.
- **Decided (Kelby, Oct 16):** pricing is shared after initial outreach, not in public docs; first-build case-study discount allowed; links expire after 14 days.
- **Decided (Kelby, Oct 16):** no real prospect logos (no fetch, no upload); name and colors only.

**Open items:**
- #22 intake: CSV-only vs a paid forward inbox. CSV-only is the working default until Kelby picks.
- Vercel plan upgrade (Kelby).
- CRM_API_KEY / CORS check before any prototype link goes out.
