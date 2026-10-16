# FlowForward Campaigns CRM views (F-006)

Design spec for the CRM side of F-006 Campaigns (issue #67, §4 "CRM views"; accepted by Summit). **This is a spec only.** Ochre designs, and Delta builds after Canyon's schema/API. No production code in this PR.

Mocks live in [`campaigns/`](campaigns/) at 390px (phone, designed first) and 1280px (desktop). They were rendered from static HTML with headless Chrome; `campaigns/mock-gen.py` regenerates them.

| View | 390 | 1280 |
|---|---|---|
| Campaigns list (+ empty, loading, error) | `campaigns/list-390.png` | `campaigns/list-1280.png` |
| Campaign detail | `campaigns/detail-390.png` | `campaigns/detail-1280.png` |
| Channel comparison | `campaigns/channels-390.png` | `campaigns/channels-1280.png` |
| Leads campaign filter (sheet / column) | `campaigns/leads-filter-390.png` | `campaigns/leads-filter-1280.png` |
| Log touch drawer + toast | `campaigns/log-touch-390.png` | `campaigns/log-touch-1280.png` |

## 0. Ground rules (apply to every view)

- **Tracking only.** Nothing in these views sends email, texts, or calls. Follow-up is email-only per #40, and Kelby does it from his own mailbox, outside this feature. Log touch records what Kelby already did. The copy says so wherever an action could be misread ("Records what you already did. Nothing is sent.").
- **Flag.** Everything here sits behind `FF_CAMPAIGNS` (default OFF). When it's off, the Campaigns nav item, the Leads/Pipeline campaign chip and column, and the drawer's Log touch button don't render.
- **Observed numbers only.** Counts and rates come from the effective touch stream (#67 §3). No projections, forecasts, ROI, "expected", "on track", trend arrows, or targets. Revenue is labelled **Recorded revenue** (won deals only). Cost per lead and cost per booked call appear only when `cost_cents` was entered. They are observed ratios, not ROI.
- **Every rate shows its denominator** in the same element: the big number `37.5%`, then `3 of 8 replied` under it. Never a bare percentage. When the denominator is 0, show `—` / `No touches logged` instead of `0%`.
- **Small sample.** Any rate whose denominator (leads touched) is under 30 gets the **Directional (n<30)** label from #67 §3 (threshold confirmed at 30 on Oct 16). The rate stays visible; it is never hidden or greyed out. A/B "winner" UI is suppressed unless every compared variant has n ≥ 30, and even then both n's are shown.
- **Attribution** for booked and won follows #67 §2: last-touch by default, a first-touch toggle, a 90-day window, and one campaign/variant/channel per conversion. A one-line footnote under every table states the model.
- **`mvp_sold` counts as won** (open question 2, resolved Oct 16) in win rate and the funnel. It stays its own touch type in Log touch and timelines.
- **Fixtures and empty states.** Mocks use `TEST:`-prefixed HVAC businesses (plus one plumbing campaign), each with a **Sample** tag, and 801-555-01xx numbers. The shipped UI shows no demo data: empty states say "No campaigns yet" / "No touches logged".

## 1. Tokens and components

River Valley chrome, reusing `web/src/styles.css` variables:

| Token | Value | Use here |
|---|---|---|
| `--juniper` | #2F6B57 | primary buttons, funnel bars, segmented toggle "on" (white text 6.25:1) |
| `--juniper-wash` | #E3EFEA | selected chip / Active pill fill (juniper text 5.3:1) |
| `--ochre` | #C9952F | **non-text only**: Directional label border, Small-sample note border, Sample tag border. Never text on paper (2.47:1) |
| `--ochre-wash` + #5E4410 text | #F7EBCF | Directional label, Paused pill, Sample tag (text 7.68:1) |
| `--ink` | #1E2A2F slate | body text, toast background (paper text 13.5:1) |
| `--ink-2` | #55656B | secondary text (6.07:1 on white, 5.58:1 on paper) |
| `--rust` / `--rust-wash` | #B1452C / #F8E4DE | error banner and field error (4.56:1 on wash, 5.59:1 on white) |
| font | Barlow 400/600/700 | numbers may use `--font-num` like the fit badge |

Reused components: `.page-head`, `.btn` / `.btn-quiet`, `.chip`, `.filters`, `.table-wrap`, `.stage`-style pills, `Drawer` / `BottomSheet` (`.sheet`), `.tabbar`, `ErrorNote`, `toast()`. New, small:

- **`RateCell`** `{k, d, noun}` renders `37.5%` / `3 of 8 replied`, adds the Directional label when `d < 30`, and shows `—` when `d = 0`. Using one component everywhere keeps the denominator from being dropped.
- **`DirectionalLabel`**: ochre-wash fill, 3px ochre left border, #5E4410 text, "Directional (n<30)".
- **`SampleTag`**: only on fixture rows in mocks and on `TEST:` records in staging.

Layout rules: tap targets are at least 44px. The existing `.chip` and `.btn-sm` are 32px, so campaign views use 44px variants. Names wrap (`overflow-wrap:anywhere; white-space:normal`) and are never ellipsized. Desktop uses the existing 216px rail with a new **Campaigns** item between Pipeline and Proposals. On the phone, the tab bar gets **Campaigns** in one slot, with the rest under More (Delta to confirm against the current tab order).

## 2. Campaigns list

Route `/campaigns`. Mocks: `list-390.png`, `list-1280.png`.

- **Header:** "Campaigns", the subtitle "Observed results of your own outreach. FlowForward never sends from here.", and a **New campaign** button (full width at 390).
- **Filters:** status chips (All, Active, Paused, Ended, Draft) and a date-range chip (default is campaign lifetime, e.g. "Sep 24 – Oct 16"). Single-select, 44px.
- **1280, table.** Columns: Campaign (name wraps, Sample tag), Channel, Status pill, Dates (`start – end`, "not set" when there's no end), Enrolled, Touched, Replied, Booked, Won. Replied/Booked/Won are `RateCell`s over leads touched. Rows with 0 touched merge the three rate columns into "No touches logged". Tapping a row opens detail. Default sort: Active first, then newest start date.
- **390, cards.** Top row: name (wraps) and status pill. Then one muted line, "Channel · dates · N enrolled · N touched". Then a 3-up grid of Replied / Booked / Won `RateCell`s. The whole card is the tap target.
- Footnote: "Rates use leads touched as the denominator. Booked and won use last-touch attribution, 90-day window." It switches to "first-touch" when the Channels toggle is set; that choice is remembered in `localStorage`, like `ff.leadFilters`.
- **Status pills:** Active juniper-wash/juniper, Paused ochre-wash/#5E4410, Ended line-2/ink-2, Draft sky-wash/#2D5577.

**States** (in the strip at the bottom of both list mocks):
- **Empty:** "No campaigns yet", "Create one to start tracking replies and booked calls from your outreach.", and New campaign. No sample rows.
- **Loading:** 4 skeleton rows/cards plus "Loading campaigns…" with `aria-busy`. Never a bare spinner.
- **Error:** rust error note, "Couldn't load campaigns. Check your connection.", with a 44px **Retry**. Filters stay usable.
- **Filtered to nothing:** "No campaigns match these filters" and Clear filters.

## 3. Campaign detail

Route `/campaigns/:id`. Mocks: `detail-390.png`, `detail-1280.png`. The data is the #67 §3 fixture (`TEST: HVAC-Oct`), so the numbers match Canyon's tests exactly.

- **Header:** back link (44px), name (wraps) with Sample tag, the meta line "Channel · Status · dates · Segment", and **Edit** (quiet button). Offer hook and notes live in Edit.
- **Metric tiles** (5-up at 1280, 2-up at 390), each with its denominator or n:
  - Enrolled `8 leads`; Touched `8 leads`
  - Reply rate `37.5%` / `3 of 8 replied`; Booked rate `25%` / `2 of 8 booked`; Win rate `12.5%` / `1 of 8 won`
  - Median time to first reply `4 days` / `96 h, n = 3 replied`
  - Cost per lead `$7.50` / `$60 of 8 enrolled`; Cost per booked call `$30` / `$60 of 2 booked` (`—` when 0 booked; both tiles hidden when no cost was entered)
  - Recorded revenue `$1,500` / `1 won deal, recorded` (hidden when 0; never "potential")
- **Small-sample note** (ochre left border) when any shown rate has n < 30: "Every rate here has fewer than 30 touched leads, so it's directional. No winner is shown until each variant reaches 30."
- **Variants side by side.** One card per variant, always 2 columns at both widths. With 3+ variants the row scrolls horizontally at 390, with snap and a 160px minimum card width. Each card shows: label badge, hook summary, prototype type if set, Touched n, Replied / Booked / Won `RateCell`s (`2 of 4 replied`), and the Directional label. There is no winner crown and no "leading" color; both cards look the same. Once every variant has n ≥ 30, a neutral line such as "Higher reply rate: A (52 of 120, 43%) vs B (40 of 118, 34%)" may appear, still with both n's.
- **Funnel:** Sent → Replied → Call booked → Won as horizontal bars with counts. Prototype-link campaigns use Viewed → CTA clicked → Call booked → MVP sold (#67 §3 Prototype funnel). Caption: "Counts of leads, observed." No step-to-step % without its denominator.
- **Leads in this campaign:** rows with name (wraps), Sample tag, variant, and latest touch + date. Tapping one opens the existing lead drawer. Shows the first 4, then "Show all".
- **States:** loading shows skeleton tiles. Error shows the error note with Retry. With zero touches, tiles show `—`, variant cards say "No touches logged", and a hint points to Log touch in Leads.

## 4. Channel comparison

Route `/campaigns/channels` (a tab inside Campaigns). Mocks: `channels-390.png`, `channels-1280.png`.

- **Attribution toggle:** a segmented control, "Last touch | First touch" (radiogroup, 44px). It changes only Booked and Won. Touched and Replied are activity metrics and don't change.
- **Date range chip**, same as the list.
- **1280 table:** Channel (+ "N campaigns"), Touched, Replied, Booked, Won (all `RateCell`s over leads touched in that channel). Channels with 0 touches show "No touches logged". An **Unattributed** row shows, as counts only, booked/won conversions that had 0 or more than 1 candidate campaign (#67 §2 tie rules).
- **390:** one card per channel with the same 3-up rate grid; the Unattributed card is last.
- Footnote: "Touched counts every channel a lead was touched on, so a lead can appear in two rows. Booked and won credit exactly one channel, chosen by the model above, within 90 days."
- Channel labels: Email, Phone, SMS, Prototype link, In person, Referral, Other. Channels with no campaigns and no touches are hidden, except Phone/Email when Kelby has campaigns there.

## 5. Leads and Pipeline: campaign column and filter

Mocks: `leads-filter-390.png` (sheet open), `leads-filter-1280.png` (column + active chip).

- **Filter state** is stored as `campaign` in the existing `ff.leadFilters` object: `''` for any, a campaign id, or `none` for "Not in any campaign". It counts toward the "Filters · N" badge.
- **1280 Leads:** a **Campaign** column after Phone shows "Campaign · Variant". It wraps; several campaigns stack one per line, newest enrollment first; no campaign shows "—". A `Campaign` select joins `.filters-inline`. When it's set, an active chip ("Campaign: TEST: HVAC-Oct ✕") leads the chip row, and ✕ clears it (44px target).
- **390 Leads:** no column. The active-filter chip sits above the list. Tapping it, or "Campaign" inside the existing Filters sheet, opens a **bottom sheet**: a radio list of "Any campaign", each campaign (full name, wrapping, rows at least 52px), and "Not in any campaign", plus **Done**. Lead cards gain the line "Campaign: TEST: HVAC-Oct · A".
- **Pipeline:** the same chip and sheet at 390, and the same select at 1280, filter the board/list. Pipeline cards show the campaign line under the company name (wraps; `.card-main .lead-name` already allows wrapping). No new kanban column.
- **Empty result:** "No leads in TEST: HVAC-Oct match these filters" and Clear campaign.

## 6. Log touch (lead drawer)

Mocks: `log-touch-390.png` (bottom sheet) and `log-touch-1280.png` (side drawer). For review, the toast is composited at the top of both mocks. In the build it appears after save, once the form closes, in the standard toast position.

**Entry point:** a **Log touch** button (44px) in the lead drawer's action row (`.link-row`, next to Call / Email). It opens a sheet over the drawer at 390 and replaces the drawer body at 1280. The existing Activity log form doesn't change, and notes still go there.

**Header:** "Log touch for", the lead name (wraps), and the note **"Records what you already did. Nothing is sent."**

**Fields** (from #67 §1 `campaign_touches` and §4; no free text):

| Field | Control | Default | Validation |
|---|---|---|---|
| Type * | 44px chips, single select: Sent, Opened, Replied, Call logged, Call booked, Proposal sent, Won, Lost, MVP sold, Estimate recovered | none, must pick | required: "Pick what happened." |
| Campaign | select: the lead's enrolled campaigns first, then other Active ones, then "No campaign" | the lead's single Active enrolled campaign, else "No campaign" | optional; must exist. Choosing a campaign the lead isn't in shows "Also enroll this lead in TEST: …" (checked) |
| Variant | select of that campaign's variants + "None" | the lead's enrolled variant | optional; disabled when Campaign is "No campaign"; must belong to the chosen campaign |
| Channel | select of the 7 channels | the campaign's channel ("Email (campaign default)") | required; editable |
| When * | native `datetime-local` | now (America/Denver) | required; not in the future ("Can't be in the future."); no more than 365 days back |
| Recorded revenue | money input, dollars | empty | shown only for Won / MVP sold; optional; actual revenue only; whole number ≥ 0 |

- Errors appear inline under the field (rust text, 2px rust border, `aria-describedby`). Focus moves to the first invalid field. **Log touch** stays enabled so the error can show. Source is always `manual`.
- **Toast** (slate background, paper text): "Logged: Replied · TEST: HVAC-Oct · A. Nothing was sent." with **Undo**, which deletes that manual touch within 6 s. If saving fails, a rust error note in the form says "Couldn't log this touch. Try again." and the form keeps its values.
- The lead's timeline shows the touch as a typed entry ("Replied · TEST: HVAC-Oct A · Email") with no body.

## 7. Spec ambiguities and how this design resolves them

1. **"Small sample" vs. the spec's guardrail.** #67 §3 defines "Directional (n<30)" with n = leads touched (30 confirmed Oct 16). This design uses that label as the small-sample note on every rate with n < 30, not only on variants, and keeps those rates visible.
2. **List metrics.** §4 lists enrolled plus reply/booked/win rate, and the brief mentions sent. The list shows Enrolled, Touched (the rate denominator), and Replied/Booked/Won rates. Sent is the first funnel step on detail rather than a rate.
3. **Which touch types can be logged by hand.** §1 lists 12 types. **Summit ruling (Oct 16):** `opened` is manually loggable (opens come from a manual log or the optional pixel), so Log touch offers **10** types. `prototype_viewed` and `prototype_cta_clicked` stay system-only (from `pilot_events`). The API should accept `source = manual` only for those 10.
4. **Campaign is optional on a touch.** §1 allows a NULL `campaign_id` and §2 has a fallback rule, so "No campaign" is allowed. It defaults to the lead's single active campaign.
5. **Timestamp limits.** The spec only says "defaulting to now". Added: not in the future and no more than 365 days back. Canyon may tighten this.
6. **Revenue on Log touch.** §4's field list is type, campaign, variant and timestamp, but `revenue_cents` exists only on won/mvp_sold, and Recorded revenue needs a source. Added it as an optional field that appears only for those types. **Summit ruling (Oct 16):** keep it; it records actual revenue only (never estimated or expected).
7. **Cost metrics vs. "no ROI".** Cost per lead and per booked call are in §3 as observed ratios, so they show when cost was entered, with numerator and denominator. There is no ROI or revenue-minus-cost figure anywhere.
8. **SMS/phone channels vs. #40 email-only.** The channel enum includes sms and phone. These only label what Kelby did himself; nothing is sent. Pilot follow-up stays email-only.
9. **Pipeline.** §4 names only the Leads view. Pipeline reuses the same filter chip/sheet and a campaign line on cards, with no kanban column. **Summit ruling (Oct 16):** the Pipeline chip is approved.
10. **Phone tab order.** Campaigns takes a tab-bar slot (§1). **Summit ruling (Oct 16):** Delta confirms the final phone tab order.
11. **Fixture dates.** The §3 fixture uses relative days (won on day 20). The mocks put day 0 on Sep 24, 2026 so no event falls after today (Oct 16).
