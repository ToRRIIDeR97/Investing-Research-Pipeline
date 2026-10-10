# Less model variance: implementation programme

Live META runs on Claude Haiku 5.5 (2026-10-08 to 2026-10-10: `66637bdb`, `02c8d48b`, `50d91067`, `d6236111`, `1d427f3f`) kept failing at steps where the model was asked to do work that code can do exactly: arithmetic, classifying items, choosing what to re-run, and producing exact JSON. Across the three Haiku runs that got past setup, 64 of 255 calls needed a repair retry. In the full run, calls that needed a repair or failed account for $1.50 of the $2.61 cost.

The rule for every package: **the model makes the judgment calls; code does everything else**. Validators keep checking the judgment calls.

| Order | Package | What changes | Paid check before merge |
| --- | --- | --- | --- |
| 1 | [decision-synthesis-determinism](decision-synthesis-determinism/implementation.md) (fix 2) | Flagged items are moved instead of failing the stage. Code sets the thesis fields and the returns, which become null with a status when withheld. Invented citations are dropped and recorded in a structured field. | yes (prompt changes) |
| 2 | [deterministic-valuation](deterministic-valuation/implementation.md) (fix 1) | Operating scenarios carry yearly drivers. The model supplies only a discount rate and a terminal assumption per scenario. Code builds the statements, the DCF, the price path, the anchors and the reverse valuation. The FRED rate and tax history reach the valuation. | yes (full META run) |
| 3 | [research-request-routing](research-request-routing/implementation.md) (fix 3) | Requests are answered from captured data and research memory (keyword search) without resetting stages. Re-runs are explicit, capped, and above the cap need your approval. | no model-request changes beyond the answer packet; the DB suites cover it |
| 4 | [anthropic-structured-output](anthropic-structured-output/implementation.md) (fix 4) | On the Anthropic API path only, contracts that can be expressed as a schema are sent as `output_config.format`. Other providers and the repair loop are unchanged. | yes (provider smoke) |

Fix 2 lands first because it is small and fixes the failure that stopped run `1d427f3f` three times. Fix 1 shares the decision stage's return inputs, so it follows fix 2. Fixes 3 and 4 touch different files from 1 and 2 and from each other, so they can run in parallel once 2 is merged.

Decisions recorded for this programme:
- **Research memory stays keyword-ranked for now.** Vector search is turned on later through the existing `RESEARCH_EMBEDDING_*` settings once an embedding provider is chosen. Anthropic offers none.
- **Schema-constrained output is scoped to the `anthropic-direct` provider and Claude models.** Switching providers drops it with no code change.
- **Short evidence labels (E1, E2, …) are deferred to a follow-up.** They change the model-facing citation schema in every stage that cites evidence.

Each package has its own `acceptance/` (worker-visible) and `verification/` (independent) tests. None of the plan tests need a database except the DB-backed parts of fix 3. Run them from the repository root with `npx tsx --test Implementations/<package>/<set>/*.test.ts`.
