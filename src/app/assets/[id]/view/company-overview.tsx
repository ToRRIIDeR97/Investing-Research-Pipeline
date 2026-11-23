"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./page.module.css";
import { Card } from "@/components/ui/primitives";
import { BlendSlider, PriceChart, RunsBars, ScenarioPicker, ValueMeter, type CaseKey } from "@/components/interactive";
import { KpiGauges, RiskHeat } from "@/components/visuals/valuation-visuals";
import { Leadership } from "@/components/company/company";
import type { AssetSnapshot } from "@/lib/research/asset-snapshot";
import { verdictLine, type ResearchMemo } from "@/lib/research/reporting/research-memo";
import type { PricePoint } from "@/lib/market-data/price-series";
import { runBars, type RunRow } from "@/lib/research/run-bars";

const RANGES = ["1M", "3M", "6M", "1Y"] as const;
type Range = (typeof RANGES)[number];
type Prices = { state: "loading" } | { state: "error" } | { state: "ready"; currency: string; points: PricePoint[] };
export type OverviewRisk = { name: string; probability: number | null; severity: number | null; detail: string | null; question: React.ReactNode };

/**
 * The company overview (consumer remaster): stored prices with the base value line, what it's worth against the
 * price, the reader's own blend, every run's cost, then the report's own words. Every number is stored data; a
 * missing piece shows a plain empty state.
 */
export function CompanyOverview({ assetId, snapshot, memo, runs, fallbackStatement, risks, missing, monitorNote, onOpenReport }: {
  assetId: string;
  snapshot: AssetSnapshot | null;
  memo: ResearchMemo | null;
  runs: RunRow[];
  fallbackStatement: string | null;
  risks: OverviewRisk[];
  missing: string[] | null;
  monitorNote: string | null;
  onOpenReport: () => void;
}) {
  const [range, setRange] = useState<Range>("6M");
  const [prices, setPrices] = useState<Prices>({ state: "loading" });
  const [selected, setSelected] = useState<CaseKey>("base");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/assets/${assetId}/prices?range=${range}`)
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
      .then((data) => { if (!cancelled) setPrices({ state: "ready", currency: String(data.currency ?? "USD"), points: Array.isArray(data.points) ? data.points : [] }); })
      .catch(() => { if (!cancelled) setPrices({ state: "error" }); });
    return () => { cancelled = true; };
  }, [assetId, range]);

  const bars = useMemo(() => runBars(runs), [runs]);
  const newest = [...runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  const budget = newest ? Number(newest.budget_limit_usd) : NaN;

  const withheld = memo ? !memo.verdict.valuationComplete : false;
  const values = snapshot?.values ?? { bear: null, base: null, bull: null };
  const price = snapshot?.price ?? null;
  const currency = snapshot?.currency ?? (prices.state === "ready" ? prices.currency : "USD");
  const hasValue = !withheld && values.base != null;
  const statement = memo?.verdict.summary ?? fallbackStatement;

  return <div className={styles.overview}>
    <div className={styles.overviewRow}>
      <Card className={styles.priceCard}>
        {prices.state === "loading" ? <><h2 className={styles.cardTitle}>Price</h2><p className={styles.quiet} role="status">Loading prices…</p></>
          : prices.state === "error" ? <><h2 className={styles.cardTitle}>Price</h2><p className={styles.quiet} role="alert">Prices couldn&apos;t be loaded.</p></>
          : <PriceChart points={prices.points} currency={prices.currency} ranges={RANGES} range={range} onRange={setRange}
            valueLine={hasValue ? { label: "Base value", value: values.base as number } : null} />}
        {prices.state === "ready" && prices.points.length > 1 && <p className={styles.footnote}>Prices from stored daily closes</p>}
      </Card>
      <Card title="What it's worth" className={styles.worthCard}>
        {withheld ? <><p className={styles.withheld}>Value withheld</p>{memo?.verdict.withheldReason && <p className={styles.quiet}>{memo.verdict.withheldReason}</p>}</>
          : !hasValue ? <p className={styles.quiet}>No valuation saved for this run yet.</p>
          : <>
            <ValueMeter price={price} values={values} selected={values[selected] == null ? "base" : selected} currency={currency} />
            {values.bear != null && values.bull != null && <ScenarioPicker values={values} price={price} selected={selected} onSelect={setSelected} currency={currency} />}
            {memo && <p className={styles.answer}>{verdictLine(memo)}</p>}
          </>}
      </Card>
    </div>

    <div className={styles.overviewRow}>
      <Card className={styles.half}>
        {hasValue && values.bear != null && values.bull != null
          ? <BlendSlider values={values} price={price} reportWeighted={snapshot?.weighted ?? null} currency={currency} />
          : <><h2 className={styles.cardTitle}>Your blend</h2><p className={styles.quiet}>{withheld ? "Value withheld, so there is nothing to blend." : "Needs bear, base and bull values to blend."}</p></>}
      </Card>
      <Card className={styles.half}>
        <RunsBars runs={bars.runs} budget={Number.isFinite(budget) && budget > 0 ? budget : null} />
        {monitorNote && <p className={styles.footnote}>{monitorNote}</p>}
      </Card>
    </div>

    <div className={styles.overviewRow}>
      <Card title="The report says" action={<button type="button" className={styles.link} onClick={onOpenReport}>Full report</button>} className={styles.wideCard}>
        {statement ? <blockquote className={styles.quote}>“{statement}”</blockquote> : <p className={styles.quiet}>The report gives no conclusion to quote yet.</p>}
        {memo?.otherSide && <div className={styles.otherSide}><h3>The other side</h3><p>{memo.otherSide}</p></div>}
        {missing && missing.length > 0 && <details className={styles.missing}><summary>Research incomplete<ChevronDown size={14} /></summary><ul>{missing.map((m) => <li key={m}>{m}</li>)}</ul></details>}
      </Card>
      <Leadership subject={{ asset_id: assetId }} className={styles.narrowCard} />
    </div>

    {(snapshot?.kpis.length || risks.length) ? <div className={styles.overviewRow}>
      {snapshot && snapshot.kpis.length > 0 && <Card title="KPIs" className={styles.half}><KpiGauges kpis={snapshot.kpis} /></Card>}
      {risks.length > 0 && <Card title="Risks" className={styles.half}>
        <RiskHeat risks={risks} />
        <details className={styles.moreRisks}><summary>How each risk would show up<ChevronDown size={14} /></summary>{risks.map((risk, i) => <div key={i}>{risk.question}</div>)}</details>
      </Card>}
    </div> : null}
  </div>;
}
