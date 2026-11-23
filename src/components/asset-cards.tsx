"use client";
// Asset cards and rows for the home feed, the Research list and the review queue: logo, name, stage, key numbers.
import Link from "next/link";
import type { AssetOverview } from "@/lib/research/asset-overview";
import { CompanyLogo } from "@/components/company/company";
import { MiniRuler, money, signedPercent } from "@/components/visuals/valuation-visuals";
import { Tag } from "@/components/ui/primitives";
import { runStatusWord, statusTone } from "@/lib/research/run-status";
import styles from "./asset-cards.module.css";

export type { AssetOverview };
export const words = (value?: string | null) => value ? value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "";
export const kindLabel = (kind: string) => kind.replace(/_asset/g, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Where an asset stands, in the words of the research river. Any run of it in the review queue means "needs your
 *  decision", even when a newer run exists. */
export function stageOf(asset: AssetOverview, reviewing?: ReadonlySet<string>): { key: string; label: string; tone: ReturnType<typeof statusTone> } {
  const label = reviewing?.has(asset.id) ? "Needs your decision" : runStatusWord(asset.latest_run?.status);
  const key = { "Not started": "idea", Researching: "running", "Needs your decision": "review", "Needs plan approval": "review", Decided: "done", Completed: "done", Stopped: "stopped" }[label];
  return { key, label, tone: statusTone(label) };
}

export function AssetCard({ asset, reviewing }: { asset: AssetOverview; reviewing?: ReadonlySet<string> }) {
  const stage = stageOf(asset, reviewing);
  const s = asset.snapshot;
  return <Link href={`/assets/${asset.id}/view`} className={styles.card}>
    <div className={styles.cardHead}>
      <CompanyLogo subject={{ asset_id: asset.id }} name={asset.canonical_name} ticker={asset.ticker} size={44} />
      <div className={styles.cardTitle}>
        <strong>{asset.canonical_name}</strong>
        <span>{[asset.ticker, kindLabel(asset.asset_kind), asset.sector].filter(Boolean).join(" · ")}</span>
      </div>
      <Tag tone={stage.tone}>{stage.label}</Tag>
    </div>
    {s && s.values.base != null ? <>
      <dl className={styles.numbers}>
        <div><dt>Price</dt><dd>{money(s.price, s.currency)}</dd></div>
        <div><dt>Base</dt><dd>{money(s.values.base, s.currency)}</dd></div>
        <div><dt>Bull</dt><dd>{money(s.values.bull, s.currency)}</dd></div>
        <div><dt>Gap</dt><dd data-tone={s.gap.base == null ? undefined : s.gap.base < 0 ? "bad" : "good"}>{signedPercent(s.gap.base)}</dd></div>
      </dl>
      <MiniRuler snapshot={s} />
    </> : <p className={styles.cardNote}>{asset.latest_run ? "No valuation from this asset's runs yet." : "No research yet. Start a run to value it."}</p>}
  </Link>;
}

/** A one-line row: logo, name and ticker, stage, base value and gap. */
export function AssetRow({ asset, href, reviewing }: { asset: AssetOverview; href?: string; reviewing?: ReadonlySet<string> }) {
  const stage = stageOf(asset, reviewing);
  const s = asset.snapshot;
  return <Link href={href ?? `/assets/${asset.id}/view`} className={styles.row}>
    <CompanyLogo subject={{ asset_id: asset.id }} name={asset.canonical_name} ticker={asset.ticker} size={36} />
    <span className={styles.rowName}><strong>{asset.canonical_name}</strong><span>{[asset.ticker, kindLabel(asset.asset_kind)].filter(Boolean).join(" · ")}</span></span>
    <Tag tone={stage.tone}>{stage.label}</Tag>
    <span className={styles.rowValue}>{s?.values.base != null ? <>{money(s.values.base, s.currency)}<em data-tone={s.gap.base != null && s.gap.base < 0 ? "bad" : "good"}>{signedPercent(s.gap.base)}</em></> : <em>—</em>}</span>
  </Link>;
}
