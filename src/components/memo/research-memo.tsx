"use client";
// The Memo tab: one reading view of a run, top to bottom in a fixed order (verdict, why, what would change it, how the
// value was reached, risks, the business now, open questions). Every number comes from the server-built memo
// (src/lib/research/reporting/research-memo.ts); this file only lays it out.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { AssetSnapshot } from "@/lib/research/asset-snapshot";
import { verdictLine, type MemoBridge, type MemoSignal, type ResearchMemo, type SignalStatus } from "@/lib/research/reporting/research-memo";
import { percent, price } from "@/lib/research/reporting/plain-english";
import { RiskHeat, ValueRuler, useWidth } from "@/components/visuals/valuation-visuals";
import { C } from "@/components/ui/palette";
import ui from "@/components/research-ui.module.css";
import { DecisionPanel } from "./decision-panel";
import { SourceDrawer } from "./source-drawer";
import styles from "./memo.module.css";

export interface MemoLinks { model: string; financials: string; audit: string }

const SECTIONS = [["verdict", "Verdict"], ["why", "Why"], ["change", "What would change it"], ["value", "How the value is reached"],
  ["risks", "Risks"], ["business", "The business now"], ["questions", "Open questions"]] as const;

const signed = (r: number | null | undefined, digits = 0) => r == null ? "—" : `${r > 0 ? "+" : ""}${percent(r, digits)}`;
const shorten = (text: string, max = 130) => text.length <= max ? text : `${text.slice(0, text.lastIndexOf(" ", max)).replace(/[,;:]$/, "")}…`;

/** The memo's case values in the shape ValueRuler draws. */
function rulerSnapshot(memo: ResearchMemo): AssetSnapshot {
  const v = memo.verdict, p = v.price;
  const gap = (x: number | null) => x != null && p ? x / p - 1 : null;
  return { currency: memo.currency, price: p, price_verified: v.priceVerified, values: v.values, weighted: v.weighted,
    gap: { bear: gap(v.values.bear), base: gap(v.values.base), bull: gap(v.values.bull) }, probabilities: { bear: null, base: null, bull: null }, targets: [], kpis: [] };
}

function Cites({ ids, onOpen }: { ids: string[]; onOpen: (ids: string[], id: string) => void }) {
  if (!ids.length) return null;
  const shown = ids.slice(0, 4);
  return <>{shown.map((id, i) => <button key={id} type="button" className={styles.cite} onClick={() => onOpen(ids, id)} aria-label={`Source ${i + 1} of ${ids.length}`}>{i + 1}</button>)}
    {ids.length > shown.length && <button type="button" className={styles.cite} onClick={() => onOpen(ids, ids[shown.length])} aria-label={`${ids.length - shown.length} more sources`}>+{ids.length - shown.length}</button>}</>;
}

const signalChip: Record<SignalStatus, [string, string]> = {
  near_bear: ["critical", "Near bear trigger"], weaker: ["caution", "Weaker than base"], base: ["neutral", "In line with base"], better: ["positive", "Better than base"],
};

function Gauge({ signal }: { signal: MemoSignal }) {
  const [box, width] = useWidth<HTMLDivElement>(260);
  const W = Math.max(140, width), pad = 8, x = (u: number) => pad + u * (W - 2 * pad);
  const from = signal.baseFrom, to = signal.baseTo;
  return <div ref={box}>
    <svg width={W} height={30} viewBox={`0 0 ${W} 30`} role="img" aria-label={`${signal.label}: ${signal.display}, bear ${signal.bearDisplay}, bull ${signal.bullDisplay}`}>
      <rect x={pad} y={12} width={W - 2 * pad} height={6} rx={3} fill={C.soft} />
      {from != null && to != null && <rect x={x(from)} y={10} width={Math.max(3, x(to) - x(from))} height={10} rx={3} fill={C.navy2} />}
      <rect x={x(0) - 1} y={6} width={2.5} height={18} rx={1} fill={C.critical} />
      <rect x={x(1) - 1.5} y={6} width={2.5} height={18} rx={1} fill={C.positive} />
      <circle cx={x(signal.position)} cy={15} r={6.5} fill={C.navy} stroke={C.tile} strokeWidth={2} />
    </svg>
    <div className={styles.gaugeEnds}><span>bear {signal.bearDisplay}</span>{signal.baseDisplay && <span>base {signal.baseDisplay}</span>}<span>bull {signal.bullDisplay}</span></div>
  </div>;
}

function Bridge({ bridge, price: market, currency }: { bridge: MemoBridge; price: number | null; currency: string }) {
  const [box, width] = useWidth<HTMLDivElement>(480);
  const W = Math.max(260, width), stacked = W < 420, right = 70, left = stacked ? 0 : 200, rowH = stacked ? 64 : 50, barY = stacked ? 34 : 6;
  const end = bridge.terminal + bridge.explicit;
  const lo = Math.min(0, bridge.terminal, end, bridge.valueToday), hi = Math.max(bridge.terminal, end, bridge.valueToday, market ?? 0);
  const sx = (v: number) => left + ((v - lo) / (hi - lo || 1)) * (W - left - right);
  const money = (v: number, sign = false) => `${sign && v > 0 ? "+" : ""}${price(v, currency, true)}`;
  const rows: { label: string; sub: string; from: number; to: number; fill: string; text: string; dashed?: boolean; strong?: boolean }[] = [
    { label: `${bridge.terminalYear ?? "Terminal"} payoff, in today's money`, sub: "terminal value", from: 0, to: bridge.terminal, fill: C.navy3, text: money(bridge.terminal, true) },
    { label: bridge.explicit < 0 ? "Capital kept back to grow" : "Cash paid out before then", sub: "forecast years, net", from: bridge.terminal, to: end, fill: bridge.explicit < 0 ? C.critical : C.positive, text: money(bridge.explicit, true) },
    { label: "Value per share today", sub: "base case", from: 0, to: bridge.valueToday, fill: C.navy, text: money(bridge.valueToday), strong: true },
    ...(market != null ? [{ label: "Market price", sub: "last close", from: 0, to: market, fill: "none", text: money(market), dashed: true }] : []),
  ];
  const H = 10 + rows.length * rowH + 8;
  return <div ref={box}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={rows.map((r) => `${r.label} ${r.text}`).join(", ")}>
      {rows.map((r, i) => {
        const y = 10 + i * rowH, x0 = sx(Math.min(r.from, r.to)), x1 = sx(Math.max(r.from, r.to));
        return <g key={r.label}>
          <text x={0} y={y + 14} fontSize={13} fontWeight={r.strong ? 650 : 500} fill={C.ink}>{r.label}</text>
          <text x={0} y={y + 29} fontSize={11.5} fill={C.ink3}>{r.sub}</text>
          <rect x={x0} y={y + barY} width={Math.max(2, x1 - x0)} height={22} rx={4} fill={r.fill} stroke={r.dashed ? C.ink3 : undefined} strokeDasharray={r.dashed ? "4 3" : undefined} />
          <text x={x1 + 8} y={y + barY + 16} fontSize={13} fontWeight={650} fill={C.ink}>{r.text}</text>
        </g>;
      })}
      {!stacked && <line x1={sx(0)} x2={sx(0)} y1={8} y2={H - 6} stroke={C.lineStrong} />}
    </svg>
  </div>;
}

function useActiveSection(ids: readonly string[]) {
  const [active, setActive] = useState<string>(ids[0]);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id.replace(/^memo-/, ""));
    }, { rootMargin: "-25% 0px -65% 0px" });
    for (const id of ids) { const el = document.getElementById(`memo-${id}`); if (el) observer.observe(el); }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

const questionStatus = (status: string) => status === "blocked" ? "can't answer yet" : status === "qualified" ? "partly answered" : status === "answered" ? "answered" : "open";

export function ResearchMemoView({ memo, assetId, runId, reportHash, links, onDecided }: {
  memo: ResearchMemo; assetId: string; runId: string; reportHash: string | null; links: MemoLinks; onDecided: () => void;
}) {
  const [sources, setSources] = useState<{ ids: string[]; active: string } | null>(null);
  const [allQuestions, setAllQuestions] = useState(false);
  const ids = useMemo(() => SECTIONS.map(([id]) => id), []);
  const active = useActiveSection(ids);
  const open = (list: string[], id: string) => setSources({ ids: list, active: id });
  const closeSources = useCallback(() => setSources(null), []);
  const v = memo.verdict, c = memo.currency, val = memo.valuation;
  const confidence = v.confidence.level ? `Confidence: ${v.confidence.level}` : null;
  const statusTone = memo.status?.key === "needs_decision" || memo.status?.key === "needs_more_work" || memo.status?.key === "needs_plan_approval" ? "waiting_for_human"
    : memo.status?.key === "decided" ? "completed" : memo.status?.key === "failed" ? "failed" : "running";
  const questions = allQuestions ? memo.openQuestions : memo.openQuestions.slice(0, 4);

  return <div className={styles.layout}>
    <nav className={styles.toc} aria-label="Memo sections">
      <p className={styles.tocTitle}>Memo</p>
      {SECTIONS.map(([id, label], i) => <a key={id} href={`#memo-${id}`} aria-current={active === id ? "true" : undefined}><span>{i + 1}</span>{label}</a>)}
      <hr />
      <a href="#memo-deeper"><span>→</span>Go deeper</a>
    </nav>

    <div className={styles.body}>
      <section id="memo-verdict" className={`${styles.block} ${styles.verdictBlock}`} aria-labelledby="memo-verdict-title">
        <div className={styles.headRow}>
          <p className={styles.eyebrow} id="memo-verdict-title">Verdict</p>
          <div className={styles.chips}>
            {memo.status && <span className={ui.status} data-status={statusTone}>{memo.status.label}</span>}
            {confidence && <span className={ui.status}>{confidence}</span>}
          </div>
        </div>
        <p className={styles.verdictLine}>{verdictLine(memo)}</p>
        {v.summary && <p className={styles.summary}>{v.summary}</p>}
        <div className={styles.facts}>
          <div className={styles.fact}><span>Value per share today</span><strong>{price(v.values.base, c, true)}</strong><span>base case</span></div>
          <div className={styles.fact}><span>Market price</span><strong>{price(v.price, c, true)}</strong><span>{v.priceVerified ? "verified" : "unverified"}{v.priceDate ? `, ${v.priceDate}` : ""}</span></div>
          <div className={styles.fact}><span>Price vs value</span><strong className={v.gap == null ? undefined : v.gap < 0 ? styles.bad : styles.good}>{signed(v.gap)}</strong><span>{v.gap == null ? "no comparison" : v.gap < 0 ? "value below price" : "value above price"}</span></div>
          <div className={styles.fact}><span>Range across cases</span><strong>{v.values.bear != null && v.values.bull != null ? `${price(v.values.bear, c, true)} to ${price(v.values.bull, c, true)}` : "—"}</strong><span>bear to bull{v.weighted != null ? `, weighted ${price(v.weighted, c, true)}` : ""}</span></div>
        </div>
        {v.valuationComplete ? <ValueRuler snapshot={rulerSnapshot(memo)} /> : v.withheldReason && <p className={styles.withheld}>{v.withheldReason}</p>}
        {memo.reviewOpen && <DecisionPanel runId={runId} assetId={assetId} reportHash={reportHash} onDecided={onDecided} />}
      </section>

      {(memo.reasons.length > 0 || memo.otherSide) && <section id="memo-why" className={styles.block} aria-labelledby="memo-why-title">
        <p className={styles.eyebrow}>Why</p>
        <h2 id="memo-why-title">The main reasons</h2>
        <p className={styles.lede}>From the report&apos;s conclusion. The numbered chips open each point&apos;s sources.</p>
        <div className={styles.reasons}>{memo.reasons.map((r) => <div key={r.headline} className={styles.reason}><div>
          <h3>{r.headline}<Cites ids={r.evidenceIds} onOpen={open} /></h3>
          {r.detail && <p>{r.detail}</p>}
        </div></div>)}</div>
        {memo.otherSide && <div className={styles.otherSide}><h3>The other side</h3>{memo.otherSide}</div>}
      </section>}

      <section id="memo-change" className={styles.block} aria-labelledby="memo-change-title">
        <p className={styles.eyebrow}>What would change the view</p>
        <h2 id="memo-change-title">Signals to watch, and where they stand</h2>
        <p className={styles.lede}>Every bar reads the same way: worse on the left, better on the right.</p>
        {memo.signals.length > 0 || memo.untestable.length > 0 ? <>
          <div className={styles.direction}><span>← worse</span><span>·</span><span>better →</span></div>
          <table className={styles.signals}>
            <thead><tr><th>Signal</th><th>Now</th><th>Bear trigger · base range · bull</th><th>Status</th></tr></thead>
            <tbody>
              {memo.signals.map((s) => <tr key={s.label}>
                <td className={styles.signalName}><strong>{s.label}</strong>{s.note && <span>{shorten(s.note, 90)}</span>}</td>
                <td className={styles.now}>{s.display}</td>
                <td className={styles.gaugeCell}><Gauge signal={s} /></td>
                <td><span className={ui.status} data-status={signalChip[s.status][0]}>{signalChip[s.status][1]}</span></td>
              </tr>)}
              {memo.untestable.slice(0, 3).map((q) => <tr key={q.question} className={styles.untested}>
                <td className={`${styles.signalName} ${styles.wideName}`} colSpan={3}><strong title={q.question}>{shorten(q.question)}</strong>{q.followUp && <span>Needs: {shorten(q.followUp, 160)}</span>}</td>
                <td><span className={ui.status}>Can&apos;t test yet</span></td>
              </tr>)}
            </tbody>
          </table>
          {memo.untestable.length > 3 && <p className={styles.foot}>{memo.untestable.length - 3} more questions can&apos;t be tested yet. <a className={ui.textLink} href="#memo-questions">See open questions</a></p>}
        </> : <p className={styles.lede}>This run stored no monitored signals.</p>}
        {memo.breakers.length > 0 && <div className={styles.breakers}><h3>What would break the thesis</h3><ul>
          {memo.breakers.map((b) => <li key={b.name}><strong>{b.name}</strong>{b.threshold ? `: ${b.threshold}` : ""}</li>)}
        </ul></div>}
      </section>

      <section id="memo-value" className={styles.block} aria-labelledby="memo-value-title">
        <p className={styles.eyebrow}>How the value is reached</p>
        <h2 id="memo-value-title">{val?.method ? val.method : "The valuation"}</h2>
        {val ? <>
          <p className={styles.lede}>{val.discount ? `Cash shareholders can take out, discounted at ${percent(val.discount.rate, 1)} a year.` : "Value per share today in each case."}</p>
          {val.bridge && <div className={styles.two}>
            <Bridge bridge={val.bridge} price={v.price} currency={c} />
            {val.bridge.explicit < 0 && <div className={styles.explain}>
              <h3>Why value today is below the {val.bridge.terminalYear ?? "terminal"} target</h3>
              <p>Until {val.bridge.terminalYear ?? "the terminal year"}, the company keeps back more than it earns to fund growth. That shortfall, {price(-val.bridge.explicit, c, true)} a share in today&apos;s money, comes off the value before the later payoff.</p>
              <p>So the two numbers answer different questions: the target is what the stock might trade at then; value today is what that path is worth now.</p>
            </div>}
          </div>}
          <table className={styles.table}>
            <thead><tr><th scope="col"><span className="sr-only">Measure</span></th>{val.cases.map((x) => <th key={x.type} scope="col">{x.type[0].toUpperCase() + x.type.slice(1)}</th>)}</tr></thead>
            <tbody>
              <tr><td>Chance we assign</td>{val.cases.map((x) => <td key={x.type}>{x.probability != null ? percent(x.probability, 0) : "—"}</td>)}</tr>
              <tr className={styles.strong}><td>Value per share today</td>{val.cases.map((x) => <td key={x.type}>{price(x.valueToday, c, true)}</td>)}</tr>
              <tr><td>vs {price(v.price, c, true)} price</td>{val.cases.map((x) => <td key={x.type} className={x.gap != null && x.gap < 0 ? styles.down : styles.up}>{x.valueToday != null && x.valueToday < 0 ? "wiped out" : signed(x.gap)}</td>)}</tr>
              {val.cases.some((x) => x.exit) && <tr><td>Exit valuation</td>{val.cases.map((x) => <td key={x.type}>{x.exit ?? "—"}</td>)}</tr>}
              <tr className={styles.quiet}><td>{val.cases[0]?.targetYear ?? "Terminal"} price target</td>{val.cases.map((x) => <td key={x.type}>{price(x.target, c, true)}</td>)}</tr>
              {val.cases.some((x) => x.targetReturn != null) && <tr className={styles.quiet}><td>Return if the stock reaches it</td>{val.cases.map((x) => <td key={x.type}>{signed(x.targetReturn)}</td>)}</tr>}
            </tbody>
          </table>
          {val.weighted != null && <p className={styles.foot}>Probability-weighted value today: <strong>{price(val.weighted, c, true)}</strong>. Price targets are future prices, not today&apos;s value.</p>}
          {val.discount && <div className={styles.rate}>
            <span>Discount rate</span><span className={styles.term}><strong>{percent(val.discount.rate, 1)}</strong></span><span className={styles.op}>=</span>
            {val.discount.riskFree != null && <><span className={styles.term}>risk-free {percent(val.discount.riskFree, 2)}</span><span className={styles.op}>+</span></>}
            {val.discount.beta != null && <span className={styles.term}>beta {val.discount.beta}<span className={`${styles.tag} ${val.discount.betaVerified ? styles.verified : styles.unverified}`}>{val.discount.betaVerified ? "verified" : "unverified"}</span></span>}
            {val.discount.premium != null && <><span className={styles.op}>×</span><span className={styles.term}>equity premium {percent(val.discount.premium, 2)}</span></>}
          </div>}
          <p className={styles.foot}><Link className={ui.textLink} href={links.model}>Open the model →</Link></p>
        </> : <p className={styles.lede}>{v.withheldReason ?? "No valuation was stored for this run."}</p>}
      </section>

      {memo.risks.length > 0 && <section id="memo-risks" className={styles.block} aria-labelledby="memo-risks-title">
        <p className={styles.eyebrow}>Risks</p>
        <h2 id="memo-risks-title">What could go wrong, ranked</h2>
        <p className={styles.lede}>Likelihood × severity, from the risk register.</p>
        <RiskHeat risks={memo.risks.map((r) => ({ name: r.name, probability: r.probability, severity: r.severity, detail: r.watch ? `Watch: ${r.watch}` : null }))} />
      </section>}

      {memo.snapshot && <section id="memo-business" className={styles.block} aria-labelledby="memo-business-title">
        <p className={styles.eyebrow}>The business now</p>
        <h2 id="memo-business-title">{memo.snapshot.period} against {memo.snapshot.prior}</h2>
        <p className={styles.lede}>From the filed statements.</p>
        <table className={styles.table}>
          <thead><tr><th scope="col"><span className="sr-only">Measure</span></th><th scope="col">{memo.snapshot.prior}</th><th scope="col">{memo.snapshot.period}</th><th scope="col">Change</th></tr></thead>
          <tbody>{memo.snapshot.rows.map((r) => <tr key={r.label}>
            <td>{r.label}</td><td>{r.priorDisplay}</td><td>{r.latestDisplay}</td>
            <td className={r.better == null ? undefined : r.better ? styles.up : styles.down}>{r.change != null ? signed(r.change) : r.better == null ? "—" : r.better ? "better" : "worse"}</td>
          </tr>)}</tbody>
        </table>
        <p className={styles.foot}><Link className={ui.textLink} href={links.financials}>Full statements and KPI history →</Link></p>
      </section>}

      {memo.openQuestions.length > 0 && <section id="memo-questions" className={styles.block} aria-labelledby="memo-questions-title">
        <p className={styles.eyebrow}>Open questions</p>
        <h2 id="memo-questions-title">What the research couldn&apos;t establish</h2>
        <p className={styles.lede}>{v.confidence.openQuestions} open. A new run targets these first.</p>
        <ul className={styles.questions}>{questions.map((q) => <li key={q.question}>
          <div>{q.question}<Cites ids={q.evidenceIds} onOpen={open} /></div><span>{questionStatus(q.status)}</span>
        </li>)}</ul>
        {memo.openQuestions.length > 4 && <button type="button" className={styles.more} aria-expanded={allQuestions} onClick={() => setAllQuestions(!allQuestions)}>
          {allQuestions ? "Show fewer" : `Show ${memo.openQuestions.length - 4} more`}</button>}
      </section>}

      <div id="memo-deeper">
        <p className={styles.eyebrow} style={{ margin: "12px 0 10px" }}>Go deeper</p>
        <div className={styles.appendix}>
          <Link href={links.model}><strong>Model</strong><span>Scenarios, valuation signals and the workbench</span></Link>
          <Link href={links.financials}><strong>Financials</strong><span>Statements, KPIs and metrics</span></Link>
          <Link href={links.audit}><strong>Audit</strong><span>The full report, evidence, sources and runs</span></Link>
        </div>
      </div>
    </div>

    {sources && <SourceDrawer ids={sources.ids} active={sources.active} evidence={memo.evidence}
      onPick={(id) => setSources({ ...sources, active: id })} onClose={closeSources} />}
  </div>;
}
