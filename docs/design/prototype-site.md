> Researched Oct 20, 2026 by a UI/UX research agent for Kelby. `src/prototypes/page.js` implements this. Where it differs from `prototype-system.md` (watermark color/position, the FlowForward CTA panel), `prototype-system.md` wins.

# Sample Contractor Homepage: Design Spec (FlowForward prototype)

Goal: the prototype should read as "this shop's real website, with the automations already built in", not as a SaaS demo. Every choice below comes from what real, agency-built home-service sites do.

---

## 1. Findings

### Sites reviewed (homepages read directly)
| # | Site | Trade / market | Notable |
|---|---|---|---|
| 1 | Jacobs Heating & AC, https://jacobsheating.com | HVAC, Portland | Promo bar with phone + "Schedule Your Service!"; phone again at end of nav; local H1; badges row; license #s in footer |
| 2 | Genz-Ryan, https://genzryan.com | HVAC/plumb/elec, Twin Cities | Utility bar (coupon + "Open 24/7" + phone); "Book Appointment" header button; **mobile sticky bar: Coupons / Call / Schedule Online**; numbered process; service-area block |
| 3 | Bob's AC (Hook Agency build), https://bobsac.com | HVAC, Florida | Header "Call 833-..." + "INSTANT QUOTE!"; hero with inline lead form; **sticky mobile bar: Deals / Schedule / Call Now**; 3-step "Bob's Way"; financing band |
| 4 | Penguin Air, Plumbing & Electrical (Blue Corona client), https://www.penguinair.com | Phoenix | Logo + phone + "Schedule Now" (opens popup form); H1 "Trusted HVAC, Plumbing & Electrical Services in Phoenix, AZ"; financing band; "Why choose us" list; 16 city links |
| 5 | A-Total Plumbing, https://www.a-totalplumbing.com | Plumbing, Atlanta | City list under H1; contact form high on page; "Available 24 Hours" |
| 6 | Black Diamond Plumbing & Mechanical, https://blackdiamondtoday.com | Chicagoland | Utility strip with offer + phone; "Schedule Service" header button; 5 service tiles; 3-step process; specials with "Redeem"; town list |
| 7 | Thelen (Call Thelen), https://callthelen.com | Plumbing/HVAC/drain, MN | Phone button + "Schedule Service" in header; eyebrow + H1 + Schedule & phone buttons; 3 service cards incl. "Drains + Sewers"; 4-step process; financing; map + town list |
| 8 | YES! (The Yes Man Can), https://www.theyesmancan.com | HVAC/plumb/elec, **Utah** & NV | "Schedule Service" / "Call Us" in top nav; specials directly under hero; 4 service cards; badges row; license #s |
| 9 | AJ Alberts, https://ajalberts.com | Plumbing, Twin Cities | Header phone + "Book Service"; hero buttons "Book Service Now" / "Call 651-..." ; "Why choose" list; town list w/ map |
| 10 | Benjamin Franklin Plumbing, https://www.benjaminfranklinplumbing.com | Franchise | "Call us 24/7" line + "Book Now"; ZIP check in hero; 10-item service grid; ends with Call / Book Now links (mobile bar) |
| Ref | ServiceTitan "10 best plumbing websites" and Hook Agency HVAC/plumbing roundups | | Extra examples: Mr. Rooter, Aspen Mountain Plumbing (photo upload of problem), Eco Plumbers (chat widget), Smock HVAC (red brand) |

### Shared patterns (what shows up on nearly every one)
1. **Phone number at least twice above the fold**: in a utility bar or header (top-right), and again as a hero button. Hook Agency's Jacobs write-up singles out the "large phone number in the header." Blue Corona says phone leads outnumber form leads about 8:1 for home services.
2. **Exactly one booking verb, repeated**: "Schedule Service", "Book Service", "Book Appointment" or "Schedule Now". The same label appears in the header, hero, mid-page and closing CTA. Not "Get Started".
3. **Local, literal H1**: "[Trade] in [City], [State]" or "[City]'s [trade] experts". Redefine: visitors should see what you do, where, and how to reach you within 5 seconds.
4. **Utility bar** above the header: a short offer or "24/7" note plus the phone number (Jacobs, Genz-Ryan, Black Diamond, Bob's).
5. **Service tiles**: 3–10 trade categories with short sub-service lists and a text link. Usually plain blocks rather than "feature cards".
6. **Numbered process** of 3–5 steps ("Call → Inspection → Approve → Done") on Genz-Ryan, Bob's, Black Diamond and Thelen.
7. **Trust row**: reviews summary, manufacturer and association logos, "licensed & insured", awards. We **cannot** fabricate any of these, so we use placeholders.
8. **Offers / financing band** (Genz-Ryan, Bob's, Penguin, YES!, Black Diamond, Thelen). In our version the shop supplies the figures, or the band shows a placeholder.
9. **Service area**: a plain list of towns, often with a map.
10. **Short lead form** of 4–5 fields (name, phone, service, ZIP, message), placed high or near the bottom.
11. **Dense, dark footer** with name/address/phone (NAP), hours, "24/7 emergency", license numbers, and link columns.
12. **Mobile sticky bottom bar** with 2–3 equal buttons (Call / Schedule / Deals) on Genz-Ryan, Bob's and Benjamin Franklin.

Aesthetic common denominator: confident and somewhat loud. Big condensed uppercase headings, solid saturated brand blocks, square-ish buttons, left-aligned text, high information density, no glassmorphism, no gradients-as-decoration.

---

## 2. Section-by-section layout (in order)

Container: `max-width: 1200px; padding: 0 20px` (16px at 390px).

0. **Prototype ribbon** (fixed; this part is fixed and must stay). It is 32px tall, slate `#334155` with white 13px text: "PROTOTYPE, not live. FlowForward can make this real in days." Everything else is offset by its height (`body{padding-top:32px}`).

1. **Utility bar** (brand-dark background, 36px)
   - Desktop: left "Serving [City] & [County] · 24/7 emergency service *(if shop confirms)*"; right "Call or text **(801) 555-0123**" (placeholder number, labeled as sample in the ribbon context).
   - Mobile: collapse to one centered line: "Serving [City] area · Tap to call". It can also be hidden entirely, since the sticky bar covers it.

2. **Header** (white, 76px desktop / 60px mobile, sticky with `top:32px`)
   - Left: typographic wordmark (see §3).
   - Center: nav with Services ▾, Drain Cleaning, Water Heaters, Service Area, About, Contact. Sentence case, 15px, weight 600.
   - Right: phone block (small label "Call 24/7" over the big number), then the primary button **"Schedule Service"**.
   - Mobile: wordmark left, then a square phone icon button (44×44, brand bg) and a hamburger. No "Schedule" button here, because the sticky bar has it.

3. **Hero** (solid brand-primary block. No gradient and no photo.)
   - Two columns on desktop (7/5 split). Left column: eyebrow "Plumbing & Drain Cleaning · [City], UT" (uppercase, 14px, letterspaced, accent color). Below it the H1 "[City]'s Plumbing & Drain Experts" or "Plumbing Repair & Drain Cleaning in [City], Utah". Then one line of sub-copy, then buttons: **Schedule Service** (accent) and **Call (801) 555-0123** (white outline). Under the buttons, a check-mark list of 3 *operational* facts the shop confirms (e.g., "Online booking 24/7", "Text us a photo of the problem", "Free estimates on replacements"). Use only facts the shop states.
   - Right column: the **"Request a Free Estimate" form card** (white, 4–5 fields). This is where the estimate-reply automation fires (§7).
   - Visual interest without photos: a large inline-SVG line illustration (service van or house cross-section with pipe run) at 8–12% opacity, anchored bottom-right behind the form. Alternatively, a subtle repeating pattern in a 4% white tint (pipe-elbow or diagonal-stripe). Keep the hero bottom edge as one straight line. Swooshes are optional.
   - Mobile: single column. Order is H1 → sub → two full-width buttons → form directly below (not hidden).

4. **Trust / placeholder strip** (white band directly under hero, 1px bottom border)
   - 4 cells divided by vertical rules. Each cell has a dashed-outline slot with a label: "Your Google rating here", "Your license # here", "Your years in business here", "Your manufacturer / association badges here". Each cell has an icon, uses the gray `--ink-3` color, and carries a small tag "Add yours".
   - Mobile: 2×2 grid.

5. **Services** (off-white `--paper` background)
   - Section heading left-aligned: "Plumbing Services" plus one line. A text link "See all services →" sits at the far right.
   - Grid of 6–8 **service tiles** (3 or 4 columns desktop, 2 columns at 390px). One tile may be wider ("Emergency Plumbing", spans 2 columns and uses brand-primary background) to break symmetry.
   - Services by trade:
     - Plumbing: Drain Cleaning, Water Heaters, Leak Repair, Sewer Lines, Toilets & Faucets, Garbage Disposals, Water Softeners, Emergency.
     - HVAC: AC Repair, Furnace Repair, AC Install, Furnace Install, Tune-Ups, Ductwork, Indoor Air Quality, Emergency.

6. **How it works** (white). Four numbered steps in a horizontal row with big numerals: **1 Book online or call, 2 We confirm by text, 3 Tech arrives & quotes upfront, 4 Job done right**. This row quietly explains the automations. Mobile: vertical list with numerals on the left.

7. **CTA band 1** (accent background or brand-dark background)
   - "Got a clogged drain or no hot water? We can usually get out [same/next day: shop confirms]." Then the Schedule button and the phone number.
   - Mobile: stacked, buttons full width.

8. **Offers & financing slot** (paper background). Two side-by-side bordered "coupon" boxes with dashed borders and a scissors icon, labeled "Your seasonal offer here" and "Financing details here (if offered)". Never put a dollar figure here.

9. **Service area** (white). Two columns. Left: "Proudly serving Utah County" and a 3-column list of towns, e.g., Saratoga Springs, Eagle Mountain, Lehi, American Fork, Lindon, Orem, Provo. These are the shop's real towns, filled from the shop's data. Right: a simple inline-SVG "map" of a county outline with dots, or omit the map. Do not embed a fake Google Map.

10. **Reviews slot** (paper background). Heading "What [City] homeowners say". Three dashed placeholder blocks reading "Your Google reviews appear here", plus a note: "We pull these from your Google Business Profile." No stars and no names.

11. **Closing CTA band** (brand-primary). Big H2 "Need a plumber in [City]?", then the phone number as huge type (40px) and the Schedule button.

12. **Footer** (`--brand-ink` near-black tinted with brand)
   - 4 columns: wordmark + NAP + hours; Services links; Company links; "Contact" with phone, "Text us", and "Schedule online".
   - Bottom row: "License # — add yours" placeholder · © year · Privacy.

13. **Mobile sticky call bar** (≤768px only): **Call | Text | Schedule**.

14. **Chat/text-back bubble** bottom-right (desktop) or above the sticky bar (mobile). See §7.

---

## 3. Typography

Self-hosted via @fontsource. **Do not use Inter, Roboto, Poppins or system-ui for headings.**

- **Display:** `Barlow Condensed` 700 (H1/H2) and 600 (H3, tile titles, buttons). Contractor sites lean on condensed uppercase sans, and Barlow is drawn from highway/road signage, which suits trucks and vans.
- **Body/UI:** `Source Sans 3` 400 / 600 / 700. Neutral, readable, and not the AI-default Inter.
- Alternate pairing (e.g., for an "older family shop" feel): `Oswald` 600/700 + `Public Sans` 400/600.
- Packages: `@fontsource/barlow-condensed` (600, 700), `@fontsource/source-sans-3` (400, 600, 700). Preload the 700 display weight. Use `font-display: swap`.

| Role | Font | Desktop | Mobile | Weight | Case / tracking | Line-height |
|---|---|---|---|---|---|---|
| H1 | Barlow Condensed | 60px | 38px | 700 | UPPERCASE, `letter-spacing: .005em` | 1.0 |
| H2 | Barlow Condensed | 42px | 30px | 700 | UPPERCASE, `.01em` | 1.05 |
| H3 / tile title | Barlow Condensed | 24px | 21px | 600 | UPPERCASE, `.02em` | 1.15 |
| Eyebrow | Source Sans 3 | 14px | 13px | 700 | UPPERCASE, `.12em` | 1.2 |
| Body | Source Sans 3 | 18px | 17px | 400 | Sentence | 1.55 |
| Small / meta | Source Sans 3 | 15px | 14px | 400/600 | Sentence | 1.45 |
| Nav | Source Sans 3 | 16px | — | 600 | Title case, 0 | 1 |
| Button | Barlow Condensed | 20px | 20px | 600 | UPPERCASE, `.04em` | 1 |
| Header phone number | Barlow Condensed | 28px | — | 700 | `.01em`, tabular | 1 |

**Wordmark** (replaces a logo): the shop name in Barlow Condensed 700 uppercase, 28px. Set the trade word in the accent color or as a lighter weight on a second line. Example: "**WASATCH**" over "PLUMBING & DRAIN" at 12px, `.18em` tracking. You can add a simple 20px inline-SVG glyph (a water drop for plumbing, a flame or snowflake for HVAC) left of the name. Text is left-aligned. Headings are also left-aligned, except in the closing CTA band.

---

## 4. Color system

Inputs: `--brand` (primary hex from the shop) and optional `--accent` (secondary hex). Derive everything else with `color-mix()`; it is supported in all evergreen browsers.

```css
:root{
  --brand:#0E3B70;            /* shop primary */
  --accent:#F5A300;           /* shop secondary (or derived, below) */
  --brand-dark: color-mix(in srgb, var(--brand) 70%, #000);   /* hover, utility bar */
  --brand-ink:  color-mix(in srgb, var(--brand) 25%, #0b0f14);/* footer bg */
  --brand-tint: color-mix(in srgb, var(--brand) 7%, #fff);    /* soft section bg */
  --brand-line: color-mix(in srgb, var(--brand) 18%, #fff);   /* borders on tint */
  --ink:#1C2430; --ink-2:#475569; --ink-3:#64748B;            /* text */
  --paper:#F4F6F9; --white:#FFFFFF; --rule:#DCE1E8;
}
```
If the shop has only one color, use an accent of `#FFC845` (safety yellow) for blue/green brands, and `#1C2430` (charcoal) for red/orange brands.

**Where brand color goes:** utility bar (`--brand-dark`), hero block (`--brand`), primary CTA band, service-tile icons and titles, the one featured tile, step numerals, links, focus rings, the header phone number, and the footer (`--brand-ink`).
**Where accent goes:** the primary button only (Schedule Service), the hero eyebrow, the check-marks in the hero list, and the sticky-bar "Schedule" cell. It covers 5% or less of the screen.
**Where brand color must NOT go:** body text paragraphs, large text on `--brand-tint` (use `--ink`), gradients of any kind, glows or colored shadows, every button. Secondary buttons are outline or white.

**Contrast (checked, WCAG):**
- White on #0E3B70 = 11.2:1 ✓. White on #1F6FD1 = 4.9:1 (✓ normal text, borderline, so use it for large text and buttons only).
- Navy #0E3B70 on amber #F5A300 = 5.4:1 ✓. **White on amber = 2.1:1 ✗**, so accent buttons with a light accent use dark text.
- White on #C8102E red = 5.9:1 ✓. Charcoal #1C2430 on #FFC845 = 10.1:1 ✓.
- Runtime rule: compute luminance of `--accent` in JS (or server-side). If white-on-accent is under 4.5:1, set `--on-accent: var(--ink)`, else `#fff`. Do the same for `--on-brand`. If the shop's primary is too light for white text (contrast under 4.5:1), use `--brand-dark` for the hero.

**Navy/blue plumbing example:** `--brand:#0E3B70`, `--accent:#F5A300`. The hero is solid navy with white H1, amber eyebrow, an amber "Schedule Service" button with navy text, and a white-outline call button. The utility bar is `#0A2A4F`, the footer `#0D1724`. Tiles sit on `#F4F6F9` with navy icons.

**Red HVAC example:** `--brand:#C8102E`, `--accent:#1C2430` (charcoal). Avoid a full red hero; it reads as alarm. Use a **charcoal hero** (`#1C2430`) with a 10px red bar along its bottom edge. The H1 is white with the city name in red-tint `#FF6B7D` (large text), and the "Schedule Service" button is red `#C8102E` with white text. The utility bar is `#A30D25` (white 7.95:1). Tiles have red icons on white, and the closing CTA band is solid red. Pair a red brand with a cool icon accent (snowflake) only as an icon, never as a second fill color.

---

## 5. Component specs

Radius scale: **4px** (buttons, inputs, tiles), **6px** (form card), **0** (bands, ribbon, utility bar). No 16–24px radii and no pills, except the 56px round chat bubble.
Shadows: only two levels. `--shadow-1: 0 1px 2px rgba(16,24,40,.08)` on tiles, and `--shadow-2: 0 8px 24px rgba(16,24,40,.18)` on the hero form card, modals and the chat panel. Nothing else gets a shadow.

**Buttons**
```css
.btn{font:600 20px/1 'Barlow Condensed';text-transform:uppercase;letter-spacing:.04em;
     padding:16px 26px;border-radius:4px;border:2px solid transparent;min-height:52px;
     display:inline-flex;gap:10px;align-items:center}
.btn-primary{background:var(--accent);color:var(--on-accent)}
.btn-primary:hover{background:color-mix(in srgb,var(--accent) 85%,#000)}
.btn-outline{border-color:currentColor;color:#fff;background:transparent} /* on brand */
.btn-outline-dark{border-color:var(--brand);color:var(--brand)}          /* on white */
```
Labels are verbs plus the object: "Schedule Service", "Call (801) 555-0123", "Get My Estimate", "Text Us a Photo". Never "Get Started", "Learn More" or "Try it". Use a phone SVG icon (20px) at the left of call buttons.

**Header phone**: a two-line block. The first line is "CALL 24/7" (or "CALL OR TEXT") at 12px/700, `.12em`, `--ink-3`. The second is the number at 28px Barlow Condensed 700 in `--brand`, wrapped in `<a href="tel:">`, with a 22px phone icon in a 40px `--brand-tint` square (radius 4px). On hover, underline the number.

**Service tile**
```css
.tile{background:#fff;border:1px solid var(--rule);border-radius:4px;padding:24px 22px;
      box-shadow:var(--shadow-1);display:grid;gap:10px}
.tile:hover{border-color:var(--brand)}  /* no lift, no scale */
.tile svg{width:40px;height:40px;stroke:var(--brand);stroke-width:2.25;fill:none}
```
Icons: one consistent family drawn on a 24px grid, **2.25px stroke, square caps** (sturdier than 1.5px hairline icons). Use trade objects such as a wrench, drain with swirl, water heater tank, pipe joint, toilet, faucet, snowflake, flame, fan and thermostat. Put the icon **left of the title** (inline row), not centered in a circle above it. Under the title add 2–3 sub-services in 15px `--ink-2`, and finish with the link "Drain cleaning →" in `--brand` 600. The featured tile is brand background, white text and icon, and spans 2 columns.

**Trust / placeholder strip cells**: `border:1.5px dashed var(--rule); border-radius:4px; padding:16px; color:var(--ink-3)`, with a 24px icon and the label "Your Google rating here". Add a small tag `ADD YOURS` (11px/700, `.1em`, background `--paper`, padding 2px 6px). These must look intentionally blank, never like real data.

**CTA band**: full-bleed, `padding:56px 0` (40px mobile), square edges, solid color. On desktop the H2 sits left and the buttons right. A 6px accent rule can sit on the top edge. No background image.

**Forms**: labels above the fields, 15px/600. Inputs are 52px tall, `border:1.5px solid #B8C1CC`, radius 4px, focus `outline:3px solid color-mix(in srgb,var(--brand) 35%,#fff)`. Submit is a full-width primary button. Microcopy under the button: "We'll text you back within minutes."

**Footer**: `--brand-ink` background, text `rgba(255,255,255,.78)`, headings white Barlow Condensed 18px uppercase. The phone number is 24px white. 40px column gap, 64px top padding, and a bottom bar separated by `1px solid rgba(255,255,255,.12)`.

**Mobile sticky call bar** (≤768px)
```css
.callbar{position:fixed;left:0;right:0;bottom:0;display:grid;grid-template-columns:1fr 1fr 1.2fr;
  height:60px;z-index:50;padding-bottom:env(safe-area-inset-bottom);box-shadow:0 -2px 8px rgba(0,0,0,.15)}
.callbar a{display:flex;align-items:center;justify-content:center;gap:8px;
  font:600 18px 'Barlow Condensed';text-transform:uppercase;letter-spacing:.04em}
/* Call = --brand / white, Text = --brand-dark / white, Schedule = --accent / --on-accent */
body{padding-bottom:60px}
```

---

## 6. "AI tells" checklist (remove all of these from the current version)

| ✗ Tell (current page / common AI output) | ✓ Do instead |
|---|---|
| Pill-shaped tabs switching between demos | No tabs. The demos live inside the real page components (§7) |
| Rounded 16–24px cards with soft shadows everywhere | 4px radius, 1px rules, shadows only on floating elements |
| Soft gradient hero / purple-blue fades | Solid brand block with a straight edge and an SVG line-art illustration at low opacity |
| Small "Try it" badges / sparkle emojis | A plain-text hint in the ribbon only, e.g., "Tip: submit the form or tap Schedule to see the automations" |
| Fake browser frame around the site | The page *is* the site, full-bleed. Only the ribbon says it's a prototype |
| Right-rail pricing card | Delete it. FlowForward pricing doesn't belong on the shop's site; put it on a separate FlowForward page |
| Inter / system font, medium weights | Barlow Condensed uppercase display + Source Sans 3 |
| Everything centered | Left-aligned headings and copy; only the closing band is centered |
| Three identical icon-in-circle-above-heading cards | Icon-left tiles, 6–8 of them, plus one wide featured tile |
| Generic copy ("Seamless solutions for your home") | Literal local copy: "Drain Cleaning in Lehi, UT", "No hot water? Book a tech online." |
| "Get Started" / "Learn More" CTAs | "Schedule Service", "Call (801)…", "Get My Estimate" |
| Pure #FFF/#000 everywhere, gray text on color | `--paper` off-white sections, `--brand-ink` footer, white text on brand |
| Brand color ignored (default blue) | All color derived from the shop's hex at render time |
| Invented stars / "Trusted by 10,000 homeowners" | Dashed "Your reviews here" slots |
| Glass, blur, glow, bounce animations | No blur. 150ms color transitions only. Respect `prefers-reduced-motion` |
| Uniform spacing in every section | Vary the rhythm: dense trust strip (24px), roomy services (80px), tight CTA bands (56px) |

Quick test (from 21st.dev): cover the wordmark and read the page. If it could be any shop in any city, the copy isn't specific enough.

---

## 7. Presenting the automations as part of a real site

Principle: each automation runs from a control a real customer would touch, and its result looks like what the customer would see. A small dark "behind the scenes" note explains what just happened for the owner viewing the demo.

1. **Online booking**: every "Schedule Service" button opens a **booking modal** (`<dialog>`, 560px wide, radius 6px, `--shadow-2`; full-screen sheet on mobile). It has 3 steps with a thin progress line, not pills: (1) pick the service from a list of radio rows with icons, (2) pick a day and time from a simple grid of the next 5 weekdays × 3 windows ("8–11 AM", "11–2", "2–5"), (3) enter name, phone and address. Then the confirmation state: a big check, "You're booked for Tue 10/27, 8–11 AM", and below it a **mock SMS bubble** showing the confirmation text the customer receives. Last, a slate strip `#334155` that says "Behind the scenes: added to [Shop]'s calendar, confirmation text sent, reminder scheduled 24h before."

2. **Missed-call text-back**: tapping any phone link in the prototype opens a small sheet instead of dialing. It reads "Demo: imagine the shop missed your call", with a button "Show what the caller gets". It then animates a phone-style SMS thread: "Hi, this is [Shop]. Sorry we missed your call! What can we help with? You can also book here: [link]". The thread renders inside the **chat bubble widget** (bottom-right, 56px round brand-colored button with a text-message icon). The open panel is 360×480 with a brand header strip "[Shop] · Usually replies in minutes". Users can type a reply and get a canned answer. This is the one element that may be round.

3. **Instant estimate reply**: the hero "Request a Free Estimate" form submits in place (no page change). The card swaps to a success state: "Thanks, [Name]. Check your phone." Below that are two stacked previews, the SMS sent within seconds and the email (subject line, first two lines), each labeled with a timestamp "just now". Then the behind-the-scenes strip.

4. **Estimate follow-up**: shown inside the estimate success state as a compact **timeline** (vertical, left rule, small dots) with "Day 2: friendly check-in text", "Day 5: 'Any questions about your estimate?'", and "Day 10: last nudge + book link". Add a "Preview Day 2 text" link that adds that bubble to the chat widget.

5. **Discoverability without "Try it" badges**: the fixed ribbon gets a second, right-aligned link "See the 4 automations ▸". It opens a lightweight dropdown list with four lines (each scrolls to or opens the relevant control and briefly outlines it with a 3px accent ring). That is the only demo chrome on the page.

JS budget: one ~150-line vanilla script with `<dialog>` for the modal, class toggles, a `setTimeout`-driven typing effect, and a `color-mix`-free luminance check to choose `--on-accent`. No frameworks.

---

Sources:
- https://www.servicetitan.com/blog/plumbing-website-tips
- https://hookagency.com/hvac-websites/
- https://hookagency.com/blog/plumbing-website-design/
- https://www.bluecorona.com/blog/where-to-list-your-phone-number-on-your-website/
- https://www.bluecorona.com/website-design-services/hvac/
- https://redefineweb.com/blog/home-service-web-design-best-practices/
- https://www.scorpion.co/plumbing/ppc-plumbing-website/
- https://www.925studios.co/blog/ai-slop-design-tells
- https://cdn.jsdelivr.net/npm/pixelslop@0.3.8/dist/skill/resources/ai-slop-patterns.md
- https://21st.dev/blog/website-not-look-ai-generated
- https://jacobsheating.com
- https://genzryan.com/
- https://bobsac.com/
- https://www.penguinair.com/
- https://www.a-totalplumbing.com/
- https://blackdiamondtoday.com/
- https://callthelen.com/
- https://www.theyesmancan.com/
- https://ajalberts.com/
- https://www.benjaminfranklinplumbing.com/
