// Prototype selection rubric. Drop-in config from Scout's spec
// (docs/PROTOTYPE_PLAY.md, issue #38). This file is data only.
//
// It maps cached fit signals, including the F-003 observables from issue #23
// (free-estimate and financing language, a contact form with no booking path,
// ServiceTitan as a picker restriction), plus the gap those signals describe,
// onto a recommended prototype.
//
// F-003 job-ad and LSA signals are not in Scout's v1 matrix, so they add 0.
// quote_form is new-collect and is not scored.
//
// Plumbing has no industry points. That is a picker bias only (Summit: no
// plumbing score tweak). HVAC's place in prospectBeachhead sorts prospects,
// not agents inside one shop. Agent ties follow Scout's order: estimate
// follow-up, then the per-agent costTier in docs/PROTOTYPE_PLAY.md (1d3d0d8),
// then ownItBundled, and tieRank only when those are still tied.
// Those tiers are estimate follow-up 1, speed-to-lead 1, review requests 1,
// scheduling 2, maintenance renewal 2, dispatch 2, bookkeeping 2, and
// receptionist 3. Bookkeeping is tier 2 because it needs an accounting
// integration, not an FSM. Bookkeeping is never auto-picked. A missing
// state gets no prototype and is parked. Pest control and franchise names
// get no prototype. ServiceTitan shops only get the light prototypes.
//
// pickPrototypes reads this table. It does not fetch and it does not change
// computeFit. Unknown signals add nothing.
//
// Pest industries, franchise names, and in-state names live here. They are
// the same lists fit scoring already uses, plus the full name "Utah".

const { EXCLUDED_INDUSTRIES, FRANCHISE_PATTERNS } = require('./config');

const RUBRIC = {
  version: 1,
  spec: 'docs/PROTOTYPE_PLAY.md',
  minScore: 40,
  maxPicks: 2,
  neverAutoPick: ['bookkeeping'],
  serviceTitanAllow: ['estimate_followup', 'review_requests'],
  // Queue order for prospects. Not a per-prospect agent tie-break.
  prospectBeachhead: ['HVAC', 'Plumbing'],
  disqualify: {
    industries: EXCLUDED_INDUSTRIES,
    franchisePatterns: FRANCHISE_PATTERNS,
    inState: ['UT', 'Utah'],
  },
  // Agents an FSM already sells cheaply. ServiceTitan stays on serviceTitanAllow.
  ownItBundled: {
    jobber: ['receptionist'],
  },
  // A gap signal means the shop is missing something the agent would fill.
  gapSignals: [
    'rv_slow_quote',
    'rv_missed_call',
    'rv_scheduling',
    'no_booking',
    'contact_form_only',
    'no_chat',
    'closed_after_hours',
    'no_review_tool',
    'small_good_rating',
    'fsm_none',
  ],
  agents: {
    estimate_followup: {
      tieRank: 1,
      costTier: 1,
      points: {
        free_estimate: 25,
        financing: 20,
        rv_slow_quote: 25,
        contact_form_only: 5,
        maint_plan: 5,
        fsm_jobber_hcp: 10,
        fsm_none: 5,
        size_sweet: 10,
        size_big: 5,
        hvac: 10,
      },
    },
    speed_to_lead: {
      tieRank: 2,
      costTier: 1,
      points: {
        free_estimate: 10,
        financing: 5,
        rv_slow_quote: 10,
        rv_missed_call: 15,
        no_booking: 10,
        contact_form_only: 25,
        no_chat: 15,
        closed_after_hours: 5,
        fsm_jobber_hcp: 5,
        fsm_none: 5,
        size_sweet: 10,
        size_big: 5,
        hvac: 5,
      },
    },
    receptionist: {
      tieRank: 3,
      costTier: 3,
      points: {
        rv_missed_call: 30,
        rv_scheduling: 5,
        no_booking: 5,
        no_chat: 10,
        closed_after_hours: 20,
        fsm_none: 5,
        size_sweet: 10,
        size_big: 10,
        hvac: 5,
      },
    },
    scheduling: {
      tieRank: 4,
      costTier: 2,
      points: {
        rv_scheduling: 25,
        no_booking: 25,
        contact_form_only: 10,
        fsm_none: 10,
        size_sweet: 10,
        hvac: 5,
      },
    },
    review_requests: {
      tieRank: 5,
      costTier: 1,
      points: {
        no_review_tool: 30,
        small_good_rating: 20,
        fsm_jobber_hcp: 5,
        size_sweet: 10,
        hvac: 5,
      },
    },
    maint_renewal: {
      tieRank: 6,
      costTier: 2,
      points: {
        maint_plan: 35,
        fsm_jobber_hcp: 10,
        size_sweet: 10,
        size_big: 10,
        hvac: 10,
      },
    },
    dispatch: {
      tieRank: 7,
      costTier: 2,
      points: {
        rv_scheduling: 15,
        fsm_none: 10,
        size_sweet: 5,
        size_big: 15,
        hvac: 5,
      },
    },
    bookkeeping: {
      tieRank: 8,
      costTier: 2,
      points: {
        fsm_none: 5,
        size_sweet: 5,
      },
    },
  },
};

function rubricRows(rubric = RUBRIC) {
  const gaps = new Set(rubric.gapSignals);
  const rows = [];
  for (const [agent, spec] of Object.entries(rubric.agents)) {
    for (const [signal, points] of Object.entries(spec.points)) {
      rows.push({
        version: rubric.version,
        agent,
        signal,
        points,
        tieRank: spec.tieRank,
        gap: gaps.has(signal),
      });
    }
  }
  return rows;
}

module.exports = { RUBRIC, rubricRows };
