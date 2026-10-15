# FlowForward Grok Bot team playbook

How the Grok Bot team ships work on FlowForward. Coding agents follow `AGENTS.md` at the repo root. This file is the human process around them.

Kelby owns the product. Who presses merge, and when, is Change flow step 8.

## Roles

| Person | Role | Does | Does not |
|---|---|---|---|
| Summit | Head of Engineering | Front door. Routes work, keeps the roadmap, writes or accepts the spec before anyone builds. | Code. Merge. |
| Juniper | Chief of Staff | Ops. Morning brief, board hygiene, daily 1:1s, postmortems. | — |
| Canyon | Backend Engineer | Ships API, bot, proposals, and database work by launching cloud agents with a spec. May press merge on backend PRs (step 8). | Touch production. |
| Gauge | QA Lead | Checks the proof on every PR. Runs tests only against previews and a test database. | Test against production data or the production API. |
| Warden | Security Lead | Reviews auth, send paths, OAuth, secrets, and schema changes that run on boot. | — |
| Scout | Product Lead | Specs and acceptance for CRM behavior. | — |
| Delta | Frontend Engineer | CRM in `web/`. May press merge on frontend PRs (step 8). | — |
| Ochre | UX and Product Designer | UI and one-pager presentation. | — |

The owning engineer bot for that PR may press merge (Canyon for backend, Delta for frontend) per step 8. The coding agent that wrote the change never merges.

## Board

One GitHub Project. Columns, in order:

1. **Todo** — accepted, not started.
2. **Working** — an owner is driving it.
3. **Blocked** — cannot move. The owner says why in one line.
4. **Ready for Review** — branch is up, proof is attached, PR is open. Waiting on merge per step 8.
5. **Done** — Merged per step 8, or the card was closed without a merge and the reason is on the card.

Rules:

- One owner per card. The owner is a person (Summit, Juniper, Canyon, Gauge, Warden, Scout, Delta, Ochre), not "the agent."
- Stuck means the card is in **Blocked** and the owner sends Kelby a one-line ping: what is stuck, what they need.
- Juniper keeps the board honest in the morning brief: every Working card has an owner, every Blocked card has a reason, nothing sits in Ready for Review without a PR link.

## Change flow

1. **Spec.** Summit (or the person Summit assigns) writes what to build, what not to touch, and the proof the PR must include. Proof is the list in `AGENTS.md`: tests, backend logs, and before/after screenshots for UI.
2. **Launch.** The engineer (Canyon for backend; Delta for frontend) starts a cloud agent with that spec and the required proof. The agent does not get production credentials.
3. **Branch.** The agent pushes a branch. It does not push to `main` and does not merge.
4. **Adversarial review.** A fresh agent, one that did not write the change, reviews the diff against the spec and `AGENTS.md`.
5. **QA.** Gauge checks the proof on a preview and a test database only. Warden also reviews when the diff touches auth, send paths, OAuth, secrets, or `src/db/schema.sql`.
6. **PR.** The PR opens against `main` with the proof in the description.
7. **Board.** The owner moves the card to **Ready for Review** and links the PR.
8. **Merge.** The coding agent that wrote the change never merges. The owning engineer bot for that PR (Canyon for backend, Delta for frontend) may press merge as flowForward50, but only after proof + an independent fresh-agent review and QA pass (and Security when relevant), and it never counts as one of those passes. Never push directly to main. Merging deploys to Railway/Vercel.

## Cost

- A proposal draft is about **$0.10–$0.15** (model, cache, and a few web searches). The hard cap in code is `PROPOSAL_MAX_COST` (default $0.75) per draft.
- Google Places is free inside the monthly credit. Past that tier, searches cost money. Discovery multiplies queries by markets.
- Tests use mocks (`draft._setClient`, `send._setTransport`, and a Places mock that still has to be added). Tests do not spend.
- Any run that would spend — live Places, live Anthropic, or a real send — needs Kelby's yes first.

## Where routines stop

Scheduled and agent routines stop at a **draft, an issue, or a PR**.

They do not send email, contact a prospect, run discovery against live Places, approve a proposal, or change Railway or Vercel settings. A person does those. Kelby approves spend.

Routines never merge. Merging is always a deliberate step by the owning engineer bot, never automated by a routine. See step 8.

Nightly proposal drafting stays off (`PROPOSAL_AUTO_DRAFT` unset). Drafts are made on demand.

## Postmortem

When something breaks in production or a change ships that should not have:

1. **Root cause.** What failed, what guard was missing, and which command or env var allowed it. One paragraph, written against the code.
2. **Playbook update.** Juniper (or the owner) edits this file or `AGENTS.md` so the same miss is a rule next time. That edit is its own PR.
3. **Team announcement.** Juniper posts the cause and the new rule where the team will see it, and moves the card to Done only after both the fix and the doc update are merged.
