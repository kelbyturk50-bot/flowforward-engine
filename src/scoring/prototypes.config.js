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
// plumbing score tweak). HVAC's points are the beachhead tie-break. Remaining
// ties follow tieRank: estimate follow-up first, then cheapest to make real.
// Bookkeeping is never auto-picked. Pest control and franchise names get no
// prototype. ServiceTitan shops only get the light prototypes.
//
// pickPrototypes reads this table. It does not fetch and it does not change
// computeFit. Unknown signals add nothing.

const RUBRIC = {
  version: 1,
  spec: 'docs/PROTOTYPE_PLAY.md',
  minScore: 40,
  maxPicks: 2,
  neverAutoPick: ['bookkeeping'],
  serviceTitanAllow: ['estimate_followup', 'review_requests'],
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
