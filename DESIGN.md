# Pragma Research design system

How every screen should look, read and move. The source of truth for values is code: tokens in
[`src/app/globals.css`](src/app/globals.css), chart colours in [`src/components/ui/palette.ts`](src/components/ui/palette.ts),
shared pieces in [`src/components/ui/`](src/components/ui/) and page classes in
[`src/components/research-ui.module.css`](src/components/research-ui.module.css). This document explains them and how to
use them. If the two disagree, fix whichever is wrong in the same change.

The look is the "consumer remaster" (chosen November 2026, PR 147): friendly but professional, numbers first.

## The feel

- **Calm paper, white cards, one accent.** A warm cream page with a faint diamond grid; content sits on white cards with
  24px corners and a soft shadow. Navy is the only accent. Everything else is warm grey.
- **Numbers first.** Lead with the figure that matters (value per share, price, grade), big, in the display face. Put
  the explanation in a sentence under it, and the evidence below that.
- **Colour means something.** Green, red and amber mean good, bad and caution, and appear only on small numbers, status
  dots and thin rules. Never as a fill, a background or a decoration. One exception: the valuation bar fills the stretch
  between price and value green (cheap) or red (expensive).
- **Plain words.** Sentence case everywhere, short headings, no uppercase eyebrows, no jargon in labels. A missing value
  is an em dash (—) and the reason sits nearby.
- **Physical, quick motion.** Things that move use one gentle spring; presses squeeze slightly; nothing moves for show.

## Colour

Use the CSS variables; never a raw hex in a page or component (a test enforces this for the Quant UI). SVG and chart
code that can't read variables uses `C` and `SERIES` from `palette.ts`, kept in step with the tokens.

| Role | Token | Use |
| --- | --- | --- |
| Page | `--page` | The body background (with the diamond grid) |
| Surface | `--tile` | Cards, popovers, the selected pill, inputs on focus |
| Soft surface | `--soft` | Resting search fields, tags, quiet panels |
| Hover / track | `--hover` | Row hover, the track behind pill bars |
| Lines | `--line`, `--line-soft`, `--line-strong` | Borders; soft for dividers inside cards, strong for secondary buttons |
| Text | `--ink`, `--ink-2`, `--ink-3`, `--ink-4` | Body, secondary, meta and captions, disabled and icons |
| Accent | `--navy`, `--navy-hover`, `--navy-3`, `--navy-2`, `--navy-soft` | Primary actions, selected text, links; `--navy-soft` for grade chips and table heads |
| Brand | `--sage` | The logo mark only |
| Status | `--positive`, `--critical`, `--caution` (dots, bars), `--caution-ink` (text) | Small numbers and dots only |

Charts: navy first, then `navy3`, `ink3`, `navy2`, `ink4` (`SERIES`). Never a status colour for a series.

## Type

| Use | Face | Size and weight |
| --- | --- | --- |
| Page title (`ui.heading h1`, Home greeting) | Plus Jakarta Sans (`--font-display`) | 28 to 34px, 700, letter-spacing −0.03em |
| Section title ("Your research") | Plus Jakarta Sans | 20px, 700 |
| Card title (`Card` `h2`) | Inter | 14px, 600 |
| Big number (`BigNumber`) | Plus Jakarta Sans | 44px (34px on phones), 700, −0.03em |
| Body | Inter (`--font-sans`) | 13px base, 14 to 15px for lead text, line-height 1.5 to 1.65 |
| Meta, captions | Inter | 12 to 13px, `--ink-3` or `--ink-2` |

Figures are tabular everywhere (`tnum`). Don't introduce another face or a weight under 400.

## Shape, depth and space

- Radii: cards `--radius-card` (24px; 18 to 22px for small cards and popovers), controls `--radius-control` (12px),
  pills and buttons `--radius-pill`.
- Shadows: `--shadow-card` for resting cards, `--shadow-pop` for popovers and lifted cards, `--shadow-navy` under navy
  buttons (`--shadow-navy-lift` on hover). Cards also carry a 1px `rgb(0 0 0 / 3.5%)` border.
- **Columns open the same way.** In a multi-column layout every column starts with the same kind of element: a
  section heading (20px display, 28px row, optional text link on the right) outside the cards, then the cards. Never
  start one column with a bare heading and the next with a card; their tops won't line up (Home's "Your research" and
  "Waiting on you").
- Page: `ui.page`, 1360px wide with 24px gutters. Card padding 22 to 24px; gaps 16 to 20px between cards, 28px between
  sections. Phones: 16 to 20px padding, stacked columns, no horizontal page scroll.

## Components

Reach for these before writing new CSS.

| Need | Use |
| --- | --- |
| A panel | `Card` (title, action, `flush` for rows and tables) |
| A status | `Tag` with a tone (`waiting`, `good`, `bad`): colour on the dot only |
| A choice of 2 to 5 views | `Segmented` (sliding pill, see Motion) |
| The headline figure | `BigNumber` |
| Main action | `ui.primary` (navy pill, 38px); one per area |
| Other actions | `ui.secondary` (white pill, strong border) or `ui.textLink` (navy text) |
| A list inside a card | `ui.row`, `ui.rowTitle`, `ui.rowMeta` |
| Company identity | `CompanyLogo`: a real logo stands alone, with no tile or border, sized by its shape so every logo covers the same area (a square mark gets 70% of the box, a wordmark runs wider and shorter; `logo-box.ts`) in a 48px box on cards, 64px in a hero; without one, a ticker or initials monogram on a soft navy tile |
| Price against value | `MiniRuler`: one even 8px track, the price-to-value gap green or red, price as a dark tick, base as a navy dot, bear and bull at the ends |
| An asset without a valuation | `AssetCard` shows "Open page" and, unless a run is under way, "Run research", never a dead-end sentence. An asset can come from a search or a Quant look-up, not only from a run |
| A grade | A `--navy-soft` pill with a small label and the letter (see the Quant finder) |

Search fields are pills: a `--soft` resting fill, white with a navy ring (`0 0 0 4px var(--navy-soft)`) on focus, a
leading search icon, and a results popover of 48px rows with a logo or monogram, the name, and the ticker right-aligned.
Keyboard: arrows move, Enter opens, Escape closes; `/` focuses the page's main search.

Empty, loading and error states are sentences, not icons: "Nothing checked yet. Search above or try one of the quick
picks." Loading lists show neutral skeleton cards; errors say what failed and offer "Try again".

## Motion

Tokens (in `:root`): `--ease-spring` for anything that moves, `--ease-out` for fades and colour, `--dur-fast` (120ms,
colour), `--dur-base` (200ms, lift and press), `--dur-slide` (380ms, sliding selector), `--press-scale` (.96).

- **Buttons.** Primary buttons lift 1px on hover with a deeper navy shadow; primary and secondary buttons scale to
  `--press-scale` while pressed (80ms in, spring back). Pills and result rows squeeze the same way.
- **Cards that are links** lift 3px on hover with `--shadow-pop` and press to .98 to .985.
- **Popovers** enter with a short scale-and-fade (`finder-pop`: 6px down, .98 to 1).
- **Sliding selector.** Pill bars (main nav, `Segmented`, the financials toggles) use one white pill that glides to the
  selected item on the spring. A faint ghost pill follows the pointer across the other items. Press and drag moves the
  pill with the pointer; releasing selects the item under it, as on iOS. Escape cancels a drag. Wire a bar with
  `useSlidingIndicator` and `<SlideLayers />`, or `<SlideGroup>` for plain markup
  ([`src/components/ui/sliding.tsx`](src/components/ui/sliding.tsx)); the CSS is under "Sliding selector" in
  `globals.css`. Items stay real buttons or links: a drag ends in an ordinary click, so keyboard and aria state are
  unchanged. Bars that scroll sideways on phones (the main nav) pass `dragTouch: false`, so a swipe still scrolls.
- **Reduced motion.** Every transition and animation sits in `@media (prefers-reduced-motion: no-preference)`, and
  `globals.css` collapses durations under `reduce`. Movement then becomes an instant jump; nothing is lost.
- Don't animate layout properties on large areas, chain more than one movement per interaction, or loop anything
  except a loading skeleton.

## Accessibility

- Visible focus: a 2px navy outline, 2px offset, on every interactive element.
- Contrast: body text `--ink`/`--ink-2` on white; `--ink-3` only for meta of 12px and up; caution text uses
  `--caution-ink`.
- Charts carry `role="img"` and an `aria-label` that states the result; colour is never the only signal (pass marks
  have ✓ and × and screen-reader text).
- Combobox searches use `role="combobox"`, `aria-expanded`, `aria-controls` and `aria-activedescendant`.

## Checklist for a new screen

1. Start from `ui.page` and a display-face title, or a hero card if the page has one job (the Quant finder).
2. Lead with the number or the action; put explanation in a sentence below it.
3. Use `Card`, `Tag`, `Segmented`, `BigNumber`, `ui.primary`/`ui.secondary` before new CSS; take every colour from tokens.
4. Give each state (loading, empty, error, partial data) a sentence.
5. Check at 375px and 1280px wide, with keyboard only, and with reduced motion.

## Known gaps

- The financials module keeps its own `--fin-*` aliases and a few raw `rgba()` shadows; they map to the tokens above.
- The Quant ticker page (`quant.module.css`) predates this document: its rail uses 14px grade boxes rather than the
  grade pill.
