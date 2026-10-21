# Generates the documentation SVGs. Usage: python3 docs/diagrams/_source/make_diagrams.py docs/diagrams
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from svgkit import Svg

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
P = lambda n: os.path.join(OUT, n)

# ---------------------------------------------------------------- component
s = Svg(1100, 700, "Research OS — UML component view (current)",
        "Browser UI calls Next.js API routes (optional operator token; a middleware refuses foreign hosts and cross-site writes); the API writes Postgres and enqueues jobs; "
        "a separate worker claims jobs and runs the 24-stage pipeline, which calls the agent harness, "
        "source discovery and ingestion, backtesting (Python), and export; all state lives in Postgres and ./storage.")
s.box(30, 60, 220, 70, "Analyst browser", ["src/app/** client pages"], "ui", stereo="actor/UI")
s.box(310, 50, 260, 90, "Next.js API routes", ["src/app/api/** (53 route files)", "optional token · Host/Origin middleware"], "api", stereo="component")
s.box(640, 50, 200, 90, "Run queue", ["src/lib/research/run-queue.ts", "enqueue / claim / lease"], "lib", stereo="component")
s.box(880, 170, 200, 110, "Research worker", ["src/workers/research-worker.ts", "poll 5s · heartbeat 10s", "lease 5 min, renewed 10s · run lock"], "worker", stereo="process")
s.box(310, 200, 260, 110, "Workflow orchestrator", ["src/lib/workflow/orchestrator.ts", "advanceStage · gates · resume", "stages.ts · team-plan.ts (DAG)"], "lib", stereo="component")
s.box(610, 200, 230, 110, "Pipeline runner + team", ["pipeline-runner.ts (parallel)", "handlers/** (STAGE_HANDLERS)", "team.ts · source/research requests"], "lib", stereo="component")
s.box(30, 370, 230, 100, "Agent harness", ["src/lib/agent-harness/**", "runner · providers · registry", "cache.ts (prompt caching)"], "lib", stereo="component")
s.box(290, 370, 230, 100, "Sources & memory", ["sources/** (discovery, collector)", "memory/** (passages, embeddings,", "graph) · ingestion/** · market-data/**"], "lib", stereo="component")
s.box(550, 370, 230, 100, "Backtesting & repair", ["backtesting/** (executor, framework)", "research/repair/** (statement", "repair, node sandbox)"], "lib", stereo="component")
s.box(810, 370, 260, 100, "Reporting & export", ["research/reporting/** (adaptive)", "src/lib/export/** · valuation/**", "agents/staging.ts (promotion)"], "lib", stereo="component")
s.box(260, 560, 300, 100, "PostgreSQL 16 + pgvector", ["src/db/schema/** · drizzle 0000–0006, 0009–0012", "runs, stages, tasks, jobs, artifacts,", "evidence graph, embeddings, price bars"], "store", stereo="datastore")
s.box(600, 560, 220, 100, "./storage", ["sources/<sha256>.<ext>", "backtests/<run>/ · exports/"], "store", stereo="filesystem")
s.box(860, 540, 220, 140, "External services", ["LLM + embedding endpoints", "(OpenAI/Anthropic-compatible)", "search endpoint · DuckDuckGo · Bing", "SEC · FRED · Yahoo · Stooq · World Bank", "EIA · FDIC · Coinbase · …"], "ext", stereo="external")
s.box(30, 560, 190, 100, "Child processes", ["run_backtest.py (sandboxed)", "python3 docling_parser.py", "node --permission (repair)"], "worker", stereo="process")
# arrows
s.line([(250, 95), (310, 95)], "fetch JSON")
s.line([(570, 95), (640, 95)], "enqueue")
s.line([(840, 95), (980, 95), (980, 170)], "claim job", lx=920, ly=88)
s.line([(880, 255), (840, 255)], "run")
s.line([(610, 255), (570, 255)], "advance\nStage", lx=590, ly=238)
s.line([(440, 140), (440, 200)], "approve / review", lx=500, ly=170)
s.line([(680, 310), (145, 340), (145, 370)], "callResearchAgent", lx=330, ly=322, dashed=False)
s.line([(700, 310), (405, 370)], None)
s.line([(725, 310), (665, 370)], None)
s.line([(770, 310), (940, 370)], None)
s.line([(200, 470), (200, 525), (845, 525), (845, 600), (860, 600)], "HTTPS: models, search, data APIs", lx=560, ly=519, dashed=True)
s.line([(470, 470), (470, 525)], None, dashed=True, head=None)
s.line([(380, 470), (380, 560)], "write", lx=395, ly=545, lanchor="start")
s.line([(600, 470), (600, 505), (110, 505), (110, 560)], "execFile / spawn", lx=150, ly=499, lanchor="start")
s.line([(510, 470), (510, 490), (580, 490), (580, 545), (650, 545), (650, 560)], None)
s.line([(940, 470), (760, 560)], None)
s.line([(310, 125), (280, 125), (280, 560)], "Drizzle / SQL", lx=276, ly=458, dashed=True, lanchor="end")
s.text(16, 690, "Solid: call/dependency · Dashed: network or DB access. All library components also read/write Postgres (omitted for clarity).", 11, fill="#555")
s.save(P("component.svg"))

# ---------------------------------------------------------------- deployment
s = Svg(1060, 640, "Research OS — UML deployment view (local only)",
        "All runtime nodes run on one developer machine: Next.js server, research worker, python3 child processes, "
        "./storage, and a Docker Postgres container. Outbound HTTPS to LLM and data providers. No hosted deployment exists. "
        "Machines share research only through the research-store branch on GitHub.")
s.zone(20, 50, 700, 560, "«device» Developer macOS host", "#3b6ea8")
s.box(40, 85, 300, 110, "Next.js 15 server", ["npm run dev | build && start", "UI + /api/* route handlers", "127.0.0.1 :3000 (dev-with-db.cjs) · :3002"], "api", stereo="execution environment")
s.box(380, 85, 320, 110, "Research worker", ["npm run worker:research [-- --once]", "tsx src/workers/research-worker.ts", "env: DATABASE_URL, RESEARCH_*"], "worker", stereo="execution environment")
s.box(380, 230, 320, 90, "Child processes", ["run_backtest.py run: sandbox-exec | bwrap", "docling_parser.py · pdftotext · node (repair)"], "worker", stereo="execution environment")
s.box(40, 230, 300, 90, "Filesystem ./storage", ["sources/ · backtests/ · exports/", "gitignored"], "store", stereo="artifact")
s.zone(40, 350, 660, 135, "«execution environment» Docker (docker-compose.yml)", "#2f7f7f")
s.box(70, 380, 300, 90, "research-os-postgres", ["image pgvector/pgvector:pg16", "127.0.0.1:5432 · volume postgres_data"], "store", stereo="node")
s.box(400, 380, 280, 90, "Postgres on :5433", ["used by npm run test:sofi-v3", "Windows PG service, not in compose"], "warn", stereo="node · assumption", dashed=True)
s.box(760, 85, 280, 120, "LLM + embedding", ["RESEARCH_MODEL_BASE_URL", "RESEARCH_EMBEDDING_BASE_URL", "HTTPS + host allowlist", "or local OpenAI-compatible"], "ext", stereo="external node")
s.box(760, 240, 280, 110, "Search & web", ["RESEARCH_WEB_SEARCH_ENDPOINT", "or DuckDuckGo / Bing HTML", "discovered public URLs"], "ext", stereo="external node")
s.box(760, 380, 280, 110, "Data APIs", ["SEC EDGAR · FRED · World Bank", "Yahoo Finance / yfinance · Stooq", "EIA · FDIC · Coinbase · blockchain.info"], "ext", stereo="external node")
s.line([(190, 195), (190, 380)], "TCP 5432", lx=220, ly=340)
s.line([(400, 195), (400, 212), (360, 212), (360, 380)], "SQL", lx=365, ly=340, lanchor="start")
s.line([(540, 195), (540, 230)], "spawn", lx=565, ly=215)
s.line([(380, 275), (340, 275)], "files")
s.line([(700, 140), (760, 140)], "HTTPS")
s.line([(700, 170), (760, 290)], "HTTPS", lx=735, ly=225)
s.line([(700, 300), (760, 430)], "HTTPS", lx=740, ly=360)
s.line([(340, 120), (380, 120)], None, dashed=True)
s.text(345, 112, "DB-mediated", 10, fill="#555")
s.box(40, 505, 300, 90, "Folder ./research-store", ["worktree of branch research-store", "npm run store:sync · gitignored"], "store", stereo="artifact")
s.box(760, 510, 280, 80, "GitHub (private repo)", ["branch research-store", "other machines sync here"], "ext", stereo="external node")
s.line([(340, 550), (760, 550)], "git fetch / push", lx=550, ly=542)
s.save(P("deployment.svg"))

# ---------------------------------------------------------------- class
s = Svg(1100, 640, "Research OS — UML class view (core domain, from src/db/schema)",
        "Core persisted domain types and multiplicities: Asset has many ResearchRuns; a run has 24 stages, tasks, jobs, artifacts, "
        "model call logs, backtests and review decisions; artifacts link to evidence claims, which link to source locations in parsed documents.")
def cls(x, y, name, attrs, w=200, kind="plain"):
    h = 30 + 15 * len(attrs) + 8
    s.box(x, y, w, h, name, [], kind, rx=2)
    s.raw(f'<line x1="{x}" y1="{y+26}" x2="{x+w}" y2="{y+26}" stroke="#444"/>')
    for i, a in enumerate(attrs):
        s.text(x + 8, y + 42 + 15 * i, a, 11.5, fill="#333")
    return h
cls(30, 60, "Asset", ["id, symbol, kind", "→ research_profiles 0..1"], kind="ui")
cls(30, 200, "Instrument / Listing", ["→ market_price_bars *", "→ corporate_actions *"], kind="ui")
cls(300, 60, "ResearchRun", ["status, run_type", "pipeline_version = 3", "metadata (telemetry)"], kind="api")
cls(570, 60, "ResearchStage", ["stage_key, order 1..24", "status, validation_result_json"], kind="api")
cls(840, 60, "ResearchTask", ["status, cost_usd", "output (agent result)"], kind="api")
cls(300, 220, "ResearchRunJob", ["status queued|running|…", "lease_owner, attempt_count", "max_attempts = 3"], kind="worker")
cls(570, 220, "ResearchArtifact", ["artifact_type, scope_key, status", "version · supersedes_artifact_id"], w=230, kind="lib")
cls(840, 220, "ModelCallLog", ["model, tokens, cost", "→ budget ledger"], kind="worker")
cls(570, 380, "EvidenceClaim", ["claim, review_status", "claim_relationships (contradicts)"], w=200, kind="lib")
cls(840, 380, "SourceLocation", ["page / chunk / table ref"], kind="store")
cls(840, 500, "SourceDocument", ["sha256, storage_path", "→ parses → chunks → embeddings"], kind="store")
cls(300, 380, "ReviewDecision", ["decision, reviewer"], kind="api")
cls(300, 500, "BacktestRun", ["→ backtest_artifacts *"], kind="worker")
cls(30, 380, "Valuation / Thesis", ["valuation_signals, scenarios", "theses, risks, catalysts"], kind="lib")
cls(30, 500, "AgentOutputStaging", ["stage-output proposals", "promoted by staging accept"], kind="warn")
cls(570, 500, "MetricObservation", ["run_id → ResearchRun (* — 1)", "metric_definitions (* — 1)"], w=230, kind="lib")
def ln(pts):
    s.line(pts, head=None)
def m(x, y, t, anchor="start"):
    s.text(x, y, t, 11, fill="#a33", anchor=anchor)
ln([(230, 85), (300, 85)]); m(236, 79, "1"); m(294, 79, "*", "end")
ln([(500, 85), (570, 85)]); m(506, 79, "1"); m(564, 79, "1..24", "end")
ln([(770, 85), (840, 85)]); m(776, 79, "1"); m(834, 79, "*", "end")
ln([(130, 128), (130, 200)]); m(136, 142, "1"); m(136, 194, "*")
# bus from ResearchRun to row 2
ln([(440, 143), (440, 180)]); m(446, 158, "1")
ln([(400, 180), (940, 180)])
ln([(400, 180), (400, 220)]); m(406, 214, "0..1 active")
ln([(670, 180), (670, 220)]); m(676, 214, "*")
ln([(940, 180), (940, 220)]); m(946, 214, "*")
# spine from ResearchRun down the left
ln([(300, 120), (280, 120), (280, 525)]); m(294, 114, "1", "end")
ln([(280, 410), (230, 410)]); m(236, 404, "*")
ln([(280, 525), (230, 525)]); m(236, 519, "*")
ln([(280, 405), (300, 405)]); m(296, 399, "*", "end")
ln([(280, 525), (300, 525)]); m(296, 519, "*", "end")
ln([(670, 288), (670, 380)]); m(676, 302, "*"); m(676, 374, "*")
s.text(680, 338, "research_artifact_claim_links", 10.5, fill="#555", italic=True)
ln([(770, 400), (840, 400)]); m(774, 394, "*"); m(836, 394, "*", "end")
s.text(805, 420, "evidence_links", 10.5, fill="#555", italic=True, anchor="middle")
ln([(940, 433), (940, 500)]); m(946, 447, "*"); m(946, 494, "1")
s.text(16, 628, "Associations follow FK columns in src/db/schema/*.ts. Attribute lists are abridged; see the schema for full columns. "
       "Stage count is fixed by STAGE_CONFIGS (24).", 11, fill="#555")
s.save(P("class.svg"))

# ---------------------------------------------------------------- activity
s = Svg(1100, 800, "Research run — UML activity view",
        "Run creation with run-type skips, enqueue, worker claim with per-run advisory lock, scheduling pass over the stage dependency graph, "
        "team briefs, source and research request loops, parallel handlers, validation, per-stage retries and failureState, human gates, final quality gate.")
cx = 330
s.initial(cx, 55)
steps = [
    (75, "POST /api/assets/:id/research-runs", "run pending (v3) + 24 stages; run-type skips set at creation"),
    (140, "POST …/run-system-pipeline (or approve-plan / review)", "enqueueResearchRun (resumes failed runs) → job queued"),
    (205, "Worker: requeueExpired, reconcile → claim (SKIP LOCKED)", "lease 5 min, renewed every 10 s; lost lease or SIGTERM aborts"),
    (270, "runResearchPipeline: pg_try_advisory_lock(run)", "fail stale running tasks · startRun if pending"),
]
for y, a, b in steps:
    s.box(cx - 200, y, 400, 46, a, [b], "api" if y < 200 else "worker", title_size=12)
for y in (55, 121, 186, 251):
    s.line([(cx, y + (7 if y == 55 else 0)), (cx, y + 19)])
s.line([(cx, 316), (cx, 336)])
s.box(cx - 200, 336, 400, 46, "Scheduling pass (≤192 iterations)", ["startReadyStages (team-plan DAG) · teamBriefScheduler"], "lib", title_size=12)
s.line([(cx, 382), (cx, 398)])
s.diamond(cx, 412)
s.text(cx - 20, 400, "source / team requests pending?", 11, fill="#5a4700", italic=True, anchor="end")
s.box(470, 395, 300, 46, "Collector: in-corpus check, then fetch", ["team_requests answered; rerun only if asked"], "lib", title_size=12)
s.line([(cx + 14, 412), (470, 412)], "yes", lx=420, ly=406)
s.line([(620, 395), (620, 359), (cx + 200, 359)], None)
s.line([(cx, 426), (cx, 444)], "no", lx=345, ly=438, lanchor="start")
s.diamond(cx, 458)
s.text(cx - 20, 446, "any ready / running stage?", 11, fill="#5a4700", italic=True, anchor="end")
s.line([(cx + 14, 458), (900, 458), (900, 488)], "no", lx=600, ly=452)
s.diamond(900, 502)
s.text(920, 488, "criteria + quality gate pass?", 11, fill="#5a4700", italic=True)
s.state(960, 540, 120, 34, "run completed", "api")
s.state(760, 540, 160, 34, "run needs_more_work", "warn")
s.line([(914, 502), (1020, 502), (1020, 540)], "yes", lx=990, ly=518)
s.line([(886, 502), (840, 502), (840, 540)], "no", lx=860, ly=518)
s.line([(cx, 472), (cx, 494)], "yes", lx=345, ly=486, lanchor="start")
s.diamond(cx, 508)
s.text(cx - 20, 496, "human gate (stage 4 / 22)?", 11, fill="#5a4700", italic=True, anchor="end")
s.box(480, 540, 260, 56, "waiting_for_human; job completes", ["approval → new job enqueued"], "warn", title_size=12)
s.line([(cx + 14, 508), (610, 508), (610, 540)], "yes", lx=580, ly=502)
s.line([(cx, 522), (cx, 544)], "no", lx=345, ly=536, lanchor="start")
s.box(cx - 200, 544, 300, 46, "Ready handlers (dataflow)", ["race → advanceStage(deferNext) → newly ready"], "lib", title_size=12)
s.line([(cx, 590), (cx, 610)])
s.diamond(cx, 624)
s.text(cx - 20, 612, "output valid & validators pass?", 11, fill="#5a4700", italic=True, anchor="end")
s.line([(cx - 14, 624), (40, 624), (40, 326), (cx, 326)], "yes → stage completed", lx=50, ly=644, lanchor="start")
s.line([(cx, 638), (cx, 660)], "no", lx=345, ly=652, lanchor="start")
s.text(470, 652, "invalid → tasks invalid, artifacts needs_more_work", 11, fill="#555")
s.text(470, 665, "(founder gap only: just the founder pass)", 11, fill="#555")
s.diamond(cx, 674)
s.text(cx - 20, 666, "retryCount < stage max_retries (0–3)?", 11, fill="#5a4700", italic=True, anchor="end")
s.line([(cx + 14, 674), (445, 674), (445, 567), (cx + 100, 567)], "yes → retry", lx=450, ly=690, lanchor="start")
s.line([(cx, 688), (cx, 710)], "no", lx=345, ly=702, lanchor="start")
s.box(cx - 220, 710, 440, 60, "Apply stage failureState", ["fail_run → run failed, pending stages cancelled", "pause_for_human → waiting · skip_and_continue → stage failed, continue"], "warn", title_size=12)
s.box(860, 620, 220, 110, "Exception anywhere", ["transient model error: stage", "rerun ≤ max_retries; other throw:", "stage's tasks invalid, unless a", "provider or budget stop; run", "needs_more_work; abort: requeued"], "warn", title_size=12)
s.line([(900, 620), (900, 600), (840, 600), (840, 574)], None, dashed=True)
s.text(16, 790, "Source: pipeline-runner.ts:runResearchPipeline, orchestrator.ts:188-1040, team-plan.ts:41-75, team.ts, sources/collector.ts, run-queue.ts, stages.ts.", 11, fill="#555")
s.save(P("activity-research-run.svg"))

# ---------------------------------------------------------------- activity: valuation
s = Svg(1100, 730, "Asset valuation — UML activity view",
        "The valuation stage loads code-built inputs, separates FCFF assets from banks, withholds before any model call when inputs are missing, "
        "asks the model only for assumptions (FCFF) or equity schedules (banks), and assembles the path, anchors, returns and reverse valuation in code.")
cx = 300
s.initial(cx, 50)
s.line([(cx, 57), (cx, 70)])
s.box(100, 70, 400, 96, "Load inputs (code)", [
    "operating_scenario_set yearly_drivers · operating_model",
    "financial_inputs · historyRatios (PP&E, IC) · equityBridge · shares · analytics pack",
    "risk-free (FRED DGS10) · beta (market_price_history) · implied ERP",
    "price: stored close; historical run without one → withheld"], "lib", title_size=12)
s.line([(cx, 166), (cx, 186)])
s.diamond(cx, 200)
s.text(cx - 20, 188, "bank archetype or financials profile?", 11, fill="#5a4700", italic=True, anchor="end")
s.line([(cx + 14, 200), (760, 200), (760, 226)], "yes", lx=600, ly=194)
s.line([(cx, 214), (cx, 236)], "no", lx=cx + 6, ly=230, lanchor="start")
s.diamond(cx, 250)
s.text(cx + 20, 246, "ready? drivers for every horizon year,", 11, fill="#5a4700", italic=True)
s.text(cx + 20, 259, "shares, price, base revenue; FX + ADS ratio if foreign", 11, fill="#5a4700", italic=True)
s.line([(cx - 14, 250), (40, 250), (40, 610)], "no → withheld, no model call", lx=160, ly=244)
s.line([(cx, 264), (cx, 286)], "yes", lx=cx + 6, ly=280, lanchor="start")
s.box(130, 286, 340, 66, "valuation-analyst (model)", ["sets: conservative, base, aggressive",
    "r, g ≤ risk-free, RONIC, fade years (code defaults)"], "ui", title_size=12)
s.line([(cx, 352), (cx, 372)])
s.box(130, 372, 340, 66, "Statements → FCFF schedules (code)", ["PP&E roll-forward D&A · fade years · timing",
    "value-driver TV = NOPAT(1+g)(1−g/RONIC)/(r−g)"], "lib", title_size=12)
s.line([(cx, 438), (cx, 458)])
s.box(130, 458, 790, 66, "assembleValuation + buildFcffValuation (code)", [
    "anchors on the base set · case × set matrix · r × g grid · multiples vs own history · no-rerating · lenses",
    "reverse: implied multiple, perpetual and 10-year FCF growth · sanity flags · stress below bear (banks keep the model's)"], "lib", title_size=12)
s.box(600, 226, 320, 66, "valuation-analyst (model)", ["FCFE, dividend or book method_inputs × 3",
    "reverse_valuation, or withheld with a reason"], "ui", title_size=12)
s.line([(760, 292), (760, 312)])
s.diamond(760, 326)
s.text(780, 314, "withheld by the model?", 11, fill="#5a4700", italic=True)
s.line([(774, 326), (1070, 326), (1070, 700), (150, 700), (150, 676)], "yes", lx=1000, ly=320)
s.line([(760, 340), (760, 362)], "no", lx=766, ly=356, lanchor="start")
s.box(600, 362, 320, 66, "Primary method, shares (code)", ["first of fcff, fcfe, dividend, … with 3 scenarios",
    "diluted shares raised to the reported count"], "lib", title_size=12)
s.line([(760, 428), (760, 458)])
s.line([(525, 524), (525, 544)])
s.diamond(525, 558)
s.text(545, 546, "every anchor > 0?", 11, fill="#5a4700", italic=True)
s.line([(511, 558), (150, 558), (150, 610)], "no", lx=330, ly=552)
s.line([(539, 558), (710, 558), (710, 590)], "yes", lx=690, ly=552)
s.box(20, 610, 260, 66, "Withheld artifacts", ["anchors 0 + reason · signals not_applicable",
    "no scenario anchors; stage completes"], "warn", title_size=12)
s.box(560, 590, 300, 70, "Persist (handler)", ["valuation_signals · scenarios rows · method_schedules",
    "3 artifacts, validated"], "store", title_size=12)
s.line([(280, 640), (560, 640)])
s.line([(860, 625), (900, 625)])
s.final(910, 625)
s.text(16, 722, "Source: handlers/asset-valuation.ts, valuation/engine.ts, valuation/v2.ts, handlers/operating-scenarios.ts. Blue: model call; purple: code.", 11, fill="#555")
s.save(P("activity-valuation.svg"))

# ---------------------------------------------------------------- state machines
s = Svg(1100, 960, "Run, stage, job and artifact lifecycles — UML state machine view",
        "State machines for research_run_jobs, research_runs, research_stages and research_artifacts with transition guards from run-queue.ts, orchestrator.ts, pipeline-runner.ts, "
        "team.ts and the artifact writers, including the pause for a team-request re-run above the automatic limit.")
s.zone(20, 45, 1060, 160, "research_run_jobs (run-queue.ts)", "#b07a1f")
s.initial(55, 125)
s.state(100, 108, 120, 34, "queued", "worker")
s.state(360, 108, 120, 34, "running", "worker")
s.state(640, 80, 130, 34, "completed", "api")
s.state(640, 145, 130, 34, "failed", "warn")
s.line([(62, 125), (100, 125)], None)
s.line([(220, 118), (360, 118)], "claim [lease null/expired]\nattempt_count++", lx=290, ly=96)
s.line([(360, 136), (220, 136)], "lease expired [attempts < 3] /\nreleased: shutdown, run locked", lx=290, ly=158)
s.line([(480, 118), (640, 97)], "pipeline returned\n[owner = me]", lx=560, ly=82)
s.line([(480, 130), (640, 162)], "error [owner] / cancelRun /\nexpired [attempts ≥ 3]", lx=540, ly=170)
s.text(800, 100, "Note: 'completed' also when the run ends", 11, fill="#555")
s.text(800, 115, "waiting_for_human or needs_more_work.", 11, fill="#555")
s.text(800, 140, "Reconcile: a running run with no job", 11, fill="#555")
s.text(800, 155, "activity for 60 s gets a new queued job.", 11, fill="#555")
# Run
s.zone(20, 220, 1060, 235, "research_runs", "#4a8a3f")
s.initial(55, 317)
s.state(90, 300, 110, 34, "pending", "api")
s.state(300, 300, 110, 34, "running", "api")
s.state(540, 240, 170, 34, "waiting_for_human", "warn")
s.state(540, 385, 170, 34, "needs_more_work", "warn")
s.state(860, 262, 120, 34, "completed", "api")
s.state(860, 330, 120, 34, "failed", "warn")
s.state(860, 395, 120, 34, "cancelled", "plain")
s.line([(62, 317), (90, 317)], None)
s.line([(200, 317), (300, 317)], "startRun [pending]", lx=250, ly=310)
s.line([(410, 305), (540, 262)], "human gate / pause /\nre-run above limit", lx=482, ly=290, lanchor="start")
s.line([(540, 250), (355, 250), (355, 300)], "approve* / request-reset\n[FOR UPDATE]", lx=445, ly=231)
s.line([(395, 334), (540, 395)], "exception / blocked /\nquality gate fails", lx=490, ly=352, lanchor="start")
s.line([(540, 410), (355, 410), (355, 334)], "resumeResearchRun on enqueue", lx=445, ly=428)
s.line([(410, 314), (820, 314), (820, 279), (860, 279)], "completeRun", lx=740, ly=308)
s.line([(410, 324), (840, 324), (840, 347), (860, 347)], "failRun", lx=760, ly=338)
s.text(40, 445, "failed → running (waiting_for_human at an open gate): resume on enqueue", 11, fill="#555")
s.line([(710, 410), (860, 412)], "cancelRun", lx=785, ly=404)
s.text(560, 448, "cancelRun from any state but completed; enqueue refuses cancelled", 11, fill="#555")
# Stage
s.zone(20, 470, 1060, 255, "research_stages", "#6f4fa3")
s.initial(55, 560)
s.state(90, 543, 110, 34, "pending", "lib")
s.state(290, 543, 110, 34, "running", "lib")
s.state(290, 645, 170, 34, "waiting_for_human", "warn")
s.state(560, 500, 120, 34, "completed", "api")
s.state(560, 580, 120, 34, "failed", "warn")
s.state(95, 645, 110, 34, "skipped", "plain")
s.state(800, 580, 120, 34, "cancelled", "plain")
s.line([(62, 560), (90, 560)], None)
s.line([(200, 560), (290, 560)], "start [deps done]", lx=245, ly=553)
s.line([(62, 566), (75, 566), (75, 662), (95, 662)], None)
s.text(82, 610, "at creation", 11)
s.text(82, 623, "[skipForRunTypes]", 11)
s.line([(200, 572), (235, 572), (235, 662), (290, 662)], "gate", lx=262, ly=656)
s.line([(400, 552), (560, 517)], "valid", lx=480, ly=525)
s.line([(460, 662), (720, 662), (720, 517), (680, 517)], "approve", lx=590, ly=656)
s.line([(400, 568), (560, 597)], "retries exhausted", lx=480, ly=598)
s.raw('<path d="M370,543 C370,505 330,505 330,543" fill="none" stroke="#333" stroke-width="1.3" marker-end="url(#a)"/>')
s.text(350, 498, "retry [validation or transient model error < max_retries]", 11, anchor="middle")
s.line([(680, 597), (800, 597)], "failRun: pending →", lx=740, ly=590)
s.line([(620, 614), (620, 628), (345, 628), (345, 577)], "resume", lx=480, ly=622, dashed=True)
s.text(760, 625, "cancelRun: open stages → cancelled", 11, fill="#555")
s.text(760, 640, "resume: failed (or left running) → running; later → pending", 11, fill="#555")
s.text(290, 700, "resume: an open gate, or human_review, stays waiting_for_human", 11, fill="#555")
s.text(290, 715, "backtest withheld: backtest_review pending → skipped", 11, fill="#555")
s.text(760, 655, "skip_and_continue: failed, run continues", 11, fill="#555")
s.text(760, 670, "max_retries per stage: 0–3 (stages.ts)", 11, fill="#555")
s.text(760, 685, "owner requires_rerun: stage + dependents → pending", 11, fill="#555")
s.text(760, 700, "(auto once ≤ 6 analysis stages, else approved);", 11, fill="#555")
s.text(760, 715, "ai_reviewer waiting_for_human until the decision", 11, fill="#555")
# Artifact
s.zone(20, 740, 1060, 205, "research_artifacts (artifacts/repository.ts upsertArtifact, reporting/store.ts saveReportArtifact)", "#2f6f9f")
s.initial(55, 800)
s.state(250, 783, 130, 34, "validated", "lib")
s.state(240, 860, 150, 34, "needs_more_work", "warn")
s.state(580, 783, 120, 34, "accepted", "api")
s.state(900, 820, 130, 34, "superseded", "plain")
s.line([(62, 800), (250, 800)], "save [content contract]", lx=155, ly=792)
s.line([(315, 817), (315, 860)], "stage validators fail", lx=322, ly=843, lanchor="start")
s.line([(380, 800), (580, 800)], "human gate approves", lx=480, ly=792)
s.line([(700, 800), (860, 800), (860, 830), (900, 830)], "changed save", lx=780, ly=792)
s.line([(390, 877), (860, 877), (860, 845), (900, 845)], "retry or re-run: changed save", lx=625, ly=871)
s.text(445, 832, "plan gate: research_plan only;", 11, fill="#555")
s.text(445, 847, "stage 22: every current validated artifact", 11, fill="#555")
s.text(40, 918, "One current version per run, type and scope: a save with changed content or status inserts version n+1 and supersedes the rest;", 11, fill="#555")
s.text(40, 933, "an unchanged save keeps the row. Artifacts saved after stage 22 (export, refresh schedule, chat) stay validated.", 11, fill="#555")
s.save(P("state-machines.svg"))

# ---------------------------------------------------------------- sequence
s = Svg(1120, 1380, "Research run — UML sequence view",
        "Ordered messages from run creation through enqueue, worker claim, advisory lock, parallel stage execution with model calls, report requests "
        "answered without stage resets and the re-run approval, plan gate pause, approval and re-enqueue, the lease-expiry retry path, and cancel or shutdown.")
parts = ["Analyst UI", "API route", "Postgres", "Worker", "Pipeline runner", "Stage handler", "Agent harness", "LLM provider"]
xs = [70 + i * 140 for i in range(len(parts))]
for x, p in zip(xs, parts):
    s.box(x - 60, 45, 120, 34, p, [], "ext" if p == "LLM provider" else ("store" if p == "Postgres" else "plain"), title_size=12)
    s.raw(f'<line x1="{x}" y1="79" x2="{x}" y2="1350" stroke="#999" stroke-dasharray="4 4"/>')
y = [100]
def msg(a, b, label, ret=False):
    yy = y[0]
    xa, xb = xs[a], xs[b]
    if a == b:
        s.raw(f'<path d="M{xa},{yy} h40 v14 h-40" fill="none" stroke="#333" stroke-width="1.3" marker-end="url(#a)"/>')
        s.text(xa + 46, yy + 11, label, 11)
        y[0] += 30
        return
    s.line([(xa, yy), (xb, yy)], label, dashed=ret, head="o" if ret else "a", lx=(xa + xb) / 2, ly=yy - 5)
    y[0] += 28
def frame(label, color, x0, x1, body):
    y0 = y[0] - 6
    s.text(x0 + 6, y0 + 14, label, 11, weight="bold", fill=color)
    y[0] += 30
    body()
    s.raw(f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y[0] - y0 - 10}" fill="none" stroke="{color}" stroke-dasharray="6 3"/>')
    y[0] += 8
msg(0, 1, "POST /assets/:id/research-runs")
msg(1, 2, "insert run (pending, v3) + 24 stages [txn]")
msg(1, 0, "201 run", ret=True)
msg(0, 1, "POST /research-runs/:id/run-system-pipeline")
msg(1, 2, "enqueueResearchRun (FOR UPDATE, 1 active job)")
msg(1, 0, "202 jobId", ret=True)
msg(3, 2, "requeueExpired; claim job SKIP LOCKED (lease 5m)")
msg(3, 4, "runResearchPipeline(runId)")
msg(4, 2, "pg_try_advisory_lock(run); startRun / resume")
def loop_body():
    msg(4, 2, "startReadyStages (dependency graph)")
    msg(4, 5, "execute(ctx) × ready stages (parallel)")
    msg(5, 2, "loadFilingPassages: newest filings, driver passages")
    msg(5, 6, "callResearchAgent(role, packet + filing_passages)")
    msg(6, 7, "HTTPS chat/completions | messages (cached prefix)")
    msg(7, 6, "JSON text + usage", ret=True)
    msg(6, 5, "schema-validated output (repair/retry)", ret=True)
    msg(5, 2, "persist artifacts, evidence, tasks, model_call_logs")
    msg(4, 4, "validate → advanceStage as each settles; start newly ready")
frame("loop [scheduling pass while stages are ready]", "#6f4fa3", xs[2] - 70, xs[7] + 65, loop_body)
def requests_body():
    msg(4, 2, "processResearchRequests: no reset; review rework → requires_rerun")
    msg(4, 2, "system answers: market_price_history (incl. beta), FRED DGS10")
    msg(4, 2, "retrievePassages(source role, seeds: owner artifacts)")
    msg(4, 6, "team_answer(owner, report inputs + passages)")
    msg(6, 7, "one call; one more after a collector search")
    msg(4, 2, "requestResetPlan: none → answered · auto → reset once")
    msg(4, 2, "approval → run, ai_reviewer waiting; request_reset")
    msg(0, 1, "POST …/request-reset {rerun | skip}")
    msg(1, 2, "approveRequestReset + enqueue new job")
frame("alt [report requests in team_requests: 2 rounds pre-draft, 1 after review]", "#2f7f7f", xs[0] - 60, xs[7] + 65, requests_body)
def gate_body():
    msg(4, 2, "run + stage → waiting_for_human; release lock")
    msg(3, 2, "completeResearchRunJob (owner-guarded)")
    msg(0, 1, "POST …/approve-plan {framing edits} or …/request-plan-changes")
    msg(1, 2, "approve (save edits, research_framing) or reopen plan; enqueue job")
frame("alt [stage 4 research_plan gate]", "#b23b3b", xs[0] - 60, xs[4] + 70, gate_body)
def crash_body():
    msg(3, 2, "lease expires → requeue if attempts < 3, else failed")
frame("alt [worker crash]", "#b07a1f", xs[2] - 70, xs[4] + 70, crash_body)
def stop_body():
    msg(0, 1, "POST …/cancel")
    msg(1, 2, "cancelRun: run, stages, job closed [txn]")
    msg(3, 2, "renew lease → none (or SIGTERM)")
    msg(3, 6, "abort signal → in-flight model call cancelled")
    msg(3, 2, "release job → queued, no attempt used [owner]")
frame("alt [cancel or worker shutdown]", "#b23b3b", xs[0] - 60, xs[6] + 65, stop_body)
assert y[0] < 1350, y[0]
s.text(16, 1370, "Stage 22 human_review repeats this: POST …/review writes review_decisions; a position needs the effective review verdict; then completeRun or needs_more_work.", 11, fill="#555")
s.save(P("sequence-research-run.svg"))

# ---------------------------------------------------------------- trust boundaries
s = Svg(1100, 640, "Trust boundaries and sensitive-data flow",
        "Zones: local clients reaching the Next.js API (optional RESEARCH_OS_API_TOKEN; loopback bind, Host and Origin checks); the app/worker zone holding secrets from .env.local; "
        "Postgres and ./storage; python3 executing model-generated code; external LLM, search, and data hosts returning untrusted content.")
s.zone(20, 50, 230, 520, "Z0 Any local client", "#b23b3b")
s.box(40, 90, 190, 80, "Browser / curl", ["any local process on the", "port; other sites refused"], "warn")
s.zone(280, 50, 520, 330, "Z1 App + worker processes (trusted code)", "#4a8a3f")
s.box(300, 85, 230, 110, "Next.js API routes", ["optional operator token (#8)", "Host + Origin check, no framing", "uploads ≤ 50 MB → ./storage (Z2)"], "api")
s.box(550, 85, 230, 110, "Worker + agent harness", ["provider host allowlist", "redact() covers every key", "budget + byte/time caps"], "worker")
s.box(300, 230, 480, 120, "Secrets (.env.local, gitignored)", ["RESEARCH_MODEL_API_KEY · OPENCODE_GO_API_KEY", "RESEARCH_EMBEDDING_API_KEY · RESEARCH_WEB_SEARCH_API_KEY", "DATABASE_URL · redact() covers all of these", "backtest child gets none of these (#11)"], "warn")
s.zone(280, 400, 520, 170, "Z2 Local data stores", "#2f7f7f")
s.box(300, 435, 230, 110, "Postgres", ["research data, model call", "logs, prompts/outputs", "dev password in compose"], "store")
s.box(550, 435, 230, 110, "./storage", ["uploaded files by sha256", "backtest code + outputs", "exports"], "store")
s.zone(830, 50, 250, 250, "Z3 External hosts (untrusted output)", "#666666")
s.box(850, 85, 210, 80, "LLM + embedding", ["receive prompts / passages", "+ API keys"], "ext")
s.box(850, 185, 210, 100, "Web search / fetch", ["search endpoint · DDG · Bing", "URLs · SEC · FRED · Yahoo · Stooq…", "public-address check per hop"], "ext")
s.zone(830, 330, 250, 240, "Z4 child processes", "#b07a1f")
s.box(850, 365, 210, 120, "run_backtest.py (Z4a)", ["model-written strategy code", "OS sandbox: no network,", "writes only its own dir,", "no home/repo reads, no keys"], "warn")
s.box(850, 495, 210, 60, "repair sandbox (Z4b)", ["node --permission, empty env", "+ docling_parser.py"], "worker")
s.line([(230, 130), (300, 130)], "HTTP ± token", lx=265, ly=120)
s.line([(415, 195), (415, 230)], None, dashed=True)
s.line([(665, 195), (665, 230)], "read env", dashed=True, lx=700, ly=215)
s.line([(300, 175), (290, 175), (290, 490), (300, 490)], "SQL", lx=294, ly=470, lanchor="start")
s.line([(290, 390), (540, 390), (540, 490), (550, 490)], "write files", lx=420, ly=394)
s.line([(780, 110), (850, 110)], "prompt + key")
s.line([(850, 140), (780, 160)], "untrusted JSON", lx=815, ly=170)
s.line([(850, 235), (780, 180)], "untrusted pages", lx=815, ly=250)
s.line([(760, 195), (760, 214), (815, 214), (815, 315), (955, 315), (955, 365)], "generated code", lx=885, ly=311)
s.line([(780, 500), (850, 520)], None)
s.text(16, 595, "Red = control gap or high-sensitivity item. Arrows show data direction. Prompt-injection: no 'treat as data' wrapping found for fetched content; output is constrained by", 11, fill="#555")
s.text(16, 610, "structured-output validation and zod staging. Details and line references: docs/security.md.", 11, fill="#555")
s.save(P("trust-boundaries.svg"))

# ---------------------------------------------------------------- dev workflow
s = Svg(1100, 200, "Development workflow",
        "Feature branch, implement, local checks (lint, type-check, unit tests, build), update owning docs when boundaries change, PR, user approval, merge to main, delete branch.")
steps = [("Feature branch", "off main"), ("Implement", "+ tests"), ("Local checks", "lint · tsc · unit · build"),
         ("Docs if needed", "boundary/flow change"), ("Pull request", "→ main"), ("User approval", "explicit"),
         ("Merge + clean up", "delete branch, prune")]
x = 20
for i, (a, b) in enumerate(steps):
    s.box(x, 70, 135, 64, a, [b], ["plain", "lib", "api", "store", "ui", "warn", "worker"][i], title_size=12)
    if i:
        s.line([(x - 22, 102), (x, 102)])
    x += 157
s.line([(411, 134), (411, 165), (255, 165), (255, 134)], "fail → fix", lx=333, ly=160)
s.save(P("dev-workflow.svg"))
print("ok")
