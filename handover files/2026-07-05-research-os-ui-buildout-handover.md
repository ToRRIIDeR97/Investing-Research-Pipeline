# Research OS Handover - UI Buildout

**Date tag:** 2026-07-05
**Last updated:** 2026-07-05
**Scope:** Investing Research Pipeline / Research OS user interface
**Status:** current

## Executive Summary

This handover captures the UI buildout completed after the architecture fixes handover. The request was to fully build out the user interface using the current design as inspiration and base. The implementation keeps the existing light Kintsugi/private research console direction, but makes the main app surfaces feel like a complete operating workspace rather than a thin prototype.

The production build succeeds, and the local dev server is running at:

```text
http://localhost:3000
```

## Current State

The repository is a Next.js 15 / React 19 / TypeScript app with Tailwind v4 and `lucide-react` already installed. The UI now has a more cohesive shell, dashboard, asset catalog, and review queue. Existing deeper asset detail and run pages remain in place and were not comprehensively redesigned in this pass.

Important workspace caveat: Git reports the repo contents as untracked in this workspace, including `src/` and `handover files/`. Treat `git status --short` as workspace state rather than a clean changelog.

## What Changed

- Rebuilt the app shell:
  - `src/components/app-shell.tsx`
  - Added lucide icon navigation.
  - Added live asset and review queue counts from `/api/assets` and `/api/review/queue`.
  - Added desktop collapse/expand behavior.
  - Added mobile drawer navigation.
  - Preserved the hidden-sidebar behavior for `/run` pages.

- Rebuilt the home dashboard:
  - `src/app/page.tsx`
  - Added command-center layout with live stats.
  - Added active asset workspace table.
  - Added coverage mix chart bars based on asset kind.
  - Added runtime signal cards aligned with the latest architecture work: budget ledger enforcement, parser hardening, premium-call gating, and evidence-linked state.

- Rebuilt the asset catalog:
  - `src/app/assets/page.tsx`
  - Added search across name, slug, asset kind, sector, and status.
  - Added asset type filters with lucide icons.
  - Added visible record count.
  - Reworked cards into tighter folder-style project entries with clear metadata and workspace affordances.

- Rebuilt the review queue:
  - `src/app/review/page.tsx`
  - Added search over asset, slug, asset kind, run type, question, and priority.
  - Added open-gate and selected counters.
  - Added selected-state treatment for queue rows.
  - Reworked the right panel into a structured decision desk for verdict, conviction, priority, sizing notes, changed-mind criteria, and open questions.

## Verification

Commands run:

```bash
npm run build
curl -I http://localhost:3000/
curl -I http://localhost:3000/assets
curl -I http://localhost:3000/review
```

Results:

- `npm run build` completed successfully.
- `/`, `/assets`, and `/review` returned `HTTP/1.1 200 OK`.
- Next dev server compiled the touched routes successfully.

## Important Outputs

The key touched UI files are:

```text
src/components/app-shell.tsx
src/app/page.tsx
src/app/assets/page.tsx
src/app/review/page.tsx
```

The dev server was started with:

```bash
npm run dev
```

Observed local URL:

```text
http://localhost:3000
```

## Known Issues

- The asset detail page (`src/app/assets/[id]/page.tsx`) and archive page (`src/app/assets/[id]/view/page.tsx`) still carry more of the earlier prototype styling, including more hand-written SVGs and some wider three-column assumptions. They build, but they have not received the same polish pass as home/catalog/review.
- The run workflow page (`src/app/assets/[id]/run/page.tsx`) remains functional and was intentionally not redesigned in this pass because it has more workflow-specific behavior.
- The app still depends on API/database responses for meaningful live content. Empty databases will show empty states.
- Some global CSS overrides in `src/app/globals.css` force light translucent styling on common Tailwind classes such as `.bg-white`, `.bg-blue-600`, and color utility classes. This is part of the current design base but can surprise future component work.
- No browser screenshot or visual regression pass was performed beyond route smoke checks.

## Next Steps

1. Redesign `src/app/assets/[id]/view/page.tsx` to match the new shell and catalog density:
   - Replace hand-written SVGs with lucide icons.
   - Reduce nested card treatment.
   - Make the right info/chat panel responsive.
   - Replace emoji empty states with icons.

2. Redesign `src/app/assets/[id]/page.tsx` as a focused asset dossier:
   - Keep the charts, but improve hierarchy and actions.
   - Add clearer links into archive vs run workflow.
   - Align cards to the new 6-8px radius system.

3. Polish `src/app/assets/[id]/run/page.tsx`:
   - Convert the chat/intake flow to the same control language.
   - Keep upload/link ingest behavior intact.
   - Make the pipeline sidebar usable on narrower screens.

4. Consider extracting shared UI primitives:
   - Page header.
   - Stat tile.
   - Search/filter toolbar.
   - Empty state.
   - Status pill.

5. Perform a visual browser pass:
   - Desktop: `/`, `/assets`, `/review`, `/assets/:id`, `/assets/:id/view`, `/assets/:id/run`.
   - Mobile widths for shell drawer and catalog/review layouts.

## Practical Caveats

- This pass used existing API routes and did not alter backend behavior.
- The queue and asset counters are intentionally fetched client-side in the shell.
- The right decision panel on `/review` is currently hidden on small screens; a mobile review panel or route-level detail view should be added if mobile review workflows matter.
- `git diff` may show nothing for these files in this workspace because they are untracked. Use direct file inspection or stage intentionally before comparing.

## Files To Start With

```text
src/components/app-shell.tsx
src/app/page.tsx
src/app/assets/page.tsx
src/app/review/page.tsx
src/app/assets/[id]/page.tsx
src/app/assets/[id]/view/page.tsx
src/app/assets/[id]/run/page.tsx
src/app/globals.css
handover files/2026-07-05-research-os-architecture-fixes-handover.md
```
