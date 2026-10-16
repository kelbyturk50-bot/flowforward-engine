# FlowForward Prototype Design System

Branded clickable prototypes of FlowForward agents (scheduling, call, bookkeeping, estimate follow-up). Each one re-skins to a prospect's logo and brand color. **This is a spec only.** Delta implements it.

## 1. Theme tokens

**Inputs:** `brandPrimary` (hex, optional), `brandSecondary` (hex, optional), `logoUrl` (optional), `businessName`.

**Neutral FlowForward chrome (River Valley), fixed:**

| Token | Value |
|---|---|
| `ff.juniper` | #2F6B57 (fallback accent) |
| `ff.ochre` | #C9952F (FlowForward highlights only, never the brand) |
| `ff.slate` | #1E2A2F |
| `ff.paper` | #F3F6F5 |
| font | Barlow (400/600/700), system-ui fallback |

**Semantic tokens:**

| Token | Source | Notes |
|---|---|---|
| `surface` | paper #F3F6F5 / cards #FFFFFF | never brand |
| `on-surface` | slate #1E2A2F | |
| `muted` | #5B6B70 | secondary text (≥4.5:1 on white) |
| `border` | #D5DEDB | |
| `accent` | `fixAccent(brandPrimary)` | buttons, selected states, progress, outgoing bubbles |
| `on-accent` | white or slate | whichever contrasts more with `accent` |
| `accent-2` | `fixAccent(brandSecondary)` | optional, used only for small decoration |

The brand color goes on accents only. Surfaces stay neutral, so any brand looks premium.

## 2. Contrast safeguards (algorithm)

```
fixAccent(hex):
  if hex missing/invalid -> return juniper #2F6B57
  (L, C, H) = toOKLCH(hex)
  C = min(C, 0.20)                       # chroma cap: tames neon/oversaturated colors
  target = 4.5  (accent is used as text/link color too; 3.0 if used for UI-only fills)
  while min(contrast(c, #F3F6F5), contrast(c, #FFFFFF)) < target:
      if L > 0.6: L -= 0.01  else: L += 0.01 only when lighter can pass (i.e. dark surfaces), else L -= 0.01
      stop at L ∈ [0.05, 0.95]; if still failing -> juniper
  return gamutClip(fromOKLCH(L, C, H))   # keep hue; clamp to sRGB
onAccent(c) = contrast(c,#FFF) >= contrast(c,#1E2A2F) ? #FFFFFF : #1E2A2F
```

The surfaces are always light, so in practice this darkens. Hue is preserved, so the brand still reads as itself. Worked examples, rendered in the mockups:

| Input | Raw on paper | Accent | Accent contrast | On-accent |
|---|---|---|---|---|
| #F5E050 yellow | 1.23:1 ✗ | #846E00 | 4.59:1 ✓ | white 4.99:1 |
| #14213D navy | ~14:1 ✓ | #14213D (unchanged) | ✓ | white |
| none / logo failed | — | #2F6B57 juniper | ✓ | white |

**Logo handling**
- Max height 32px (mobile) / 40px (desktop), max width 160px, `object-fit: contain`. If it fails to load, show a text wordmark of `businessName` on an accent plate.
- Plate: sample the logo's average luminance (canvas, or a server-side precompute). If its contrast against the white header is < 3:1, put it on a slate plate (for a light logo) or a paper plate with a 1px slate inset border. Plate padding is 4px 8px, radius 6px.

## 3. Layout

Mobile-first at **390px**, desktop at **1280px**. On desktop the flow sits in a centered 720px column, with the CTA panel as a 360px sticky right rail.

**Shared shell (top → bottom):** watermark ribbon → branded header (logo + business name + "Sample business" tag) → agent title + subtitle → step progress (3–5 segments, clickable back/next) → screen content → CTA panel (after the final step on mobile, right rail on desktop) → footer.

**Key screens per agent:**
- **Scheduling:** booking calendar (slot grid) → confirmation summary.
- **Call agent:** missed call card → AI text-back conversation → booked job.
- **Bookkeeping:** receipt capture → categorized ledger → "sync to books" (toast).
- **Estimate follow-up:** stale estimate → follow-up sequence (day 1 text / day 4 email / day 8 call) → recovered job.

## 4. Watermark (non-removable)

Rendered by `PrototypeWatermark` from the prototype shell, **outside theme/brand props**. Nothing gates it: `FF_PROTOTYPE_GALLERY` gates only the gallery, never the watermark.

- **Ribbon:** exactly "PROTOTYPE, not live. FlowForward can make this real in days." (Summit-required wording; do not paraphrase). `position: sticky; top: 0`, min-height 32px and grows to fit up to two lines at 390px (padding 6px 12px, centered, line-height 1.3), Barlow 600 at 13–14px, slate #1E2A2F background, paper #F3F6F5 text (never brand colors), `role="note"`, no close button.
- **Tiled pattern:** diagonal (−30°) "PROTOTYPE" SVG tile behind content at ~5% opacity (range 4–6%), `pointer-events: none`.
- **Sample tags:** every fake datum (customer, amount, phone, business) carries a "Sample" tag or a "(sample)" suffix. Phone numbers use the 555-01xx range.
- **Footer:** "Concept by FlowForward, sample data, not affiliated with or endorsed by <Business>."
- **No real actions:** every acting button shows a toast, "In the live version this would …". No network sends.
- **Guarantee:** the watermark is server-rendered markup and tests assert it is present under hostile colors, `?watermark=0`, every flag combination, and theme overrides. CSS can't stop DevTools removal; the server markup plus the tests are the guarantee.

## 5. "How we'd make this real" CTA panel

1. Connect your phone, calendar or books.
2. We configure and test it with you.
3. Go live, with hosting and maintenance.

Timeline: **[Kelby to fill in]**. Price: **[Kelby to fill in]**. Do not invent numbers.
One primary button, **"Talk to Kelby"**, which is a plain link (`<a href>`, e.g. a booking page or `mailto:`). It never sends email automatically or submits a form.

## 6. Acceptance checklist (Delta's PR)

- [ ] Tokens implemented; brand color appears only on accent elements.
- [ ] `fixAccent` unit tests: #F5E050 → passes 4.5:1, #14213D unchanged, neon (#00FF00, #FF00FF) chroma-capped, invalid/missing → juniper.
- [ ] `onAccent` picks the higher-contrast option of white or slate.
- [ ] Logo max height, plate logic, and load-failure fallback.
- [ ] Watermark ribbon + tile + footer present; tests cover hostile colors, `?watermark=0`, flags, and theme overrides.
- [ ] Ribbon has `role="note"` and no close control.
- [ ] Every action button shows a toast; no outbound requests (asserted in the test).
- [ ] CTA uses price/timeline placeholders; "Talk to Kelby" is an `<a>`.
- [ ] Layout verified at 390 and 1280; axe shows no contrast violations.

**Screenshot proof list:** each of the 4 agents at 390 and 1280; yellow (#F5E050) and navy (#14213D) themes; the logo-fallback state; a toast visible; the CTA panel; `?watermark=0` still showing the watermark.

## Mockups (390px)

| | |
|---|---|
| ![Shell, yellow](prototype/shell-yellow.png) | ![Shell, navy](prototype/shell-navy.png) |
| ![CTA](prototype/cta-panel.png) | ![Scheduling](prototype/agent-scheduling.png) |
| ![Call](prototype/agent-call.png) | ![Bookkeeping](prototype/agent-bookkeeping.png) |
| ![Estimate](prototype/agent-estimate.png) | |
