"use client";
// Asset cards and rows for the home feed, the Research list and the review queue: logo, name, stage, key numbers.
import Link from "next/link";
import type { AssetOverview } from "@/lib/research/asset-overview";
import { CompanyLogo } from "@/components/company/company";
import { MiniRuler, money, signedPercent } from "@/components/visuals/valuation-visuals";
import { Tag } from "@/components/ui/primitives";
import { stageOf } from "@/lib/research/run-status";

export { stageOf, STAGE_KEY } from "@/lib/research/run-status";
import ui from "@/components/research-ui.module.css";
import styles from "./asset-cards.module.css";

export type { AssetOverview };
export const words = (value?: string | null) => value ? value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "";
export const kindLabel = (kind: string) => kind.replace(/_asset/g, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Where "Run research" goes for an asset: the new-research form, prefilled. */
export function researchHrefFor(asset: Pick<AssetOverview, "canonical_name" | "ticker">) {
  const q = new URLSearchParams({ name: asset.canonical_name });
  if (asset.ticker) q.set("ticker", asset.ticker);
  return `/research/new?${q}`;
}

/**
 * An asset as a card. An asset lands here from a run, a search or a Quant look-up, so it may have no valuation yet:
 * then the card offers to open its page and, unless a run is already under way, to run research. The whole card is a
 * link (a stretched title link), with the buttons layered above it, since a link can't contain buttons.
 */
export function AssetCard({ asset, reviewing }: { asset: AssetOverview; reviewing?: ReadonlySet<string> }) {
  const stage = stageOf(asset, reviewing);
  const s = asset.snapshot;
  const page = `/assets/${asset.id}/view`;
  const canRun = stage.key === "idea" || stage.key === "stopped" || stage.key === "done";
  return <article className={styles.card}>
    <div className={styles.cardHead}>
      <CompanyLogo subject={{ asset_id: asset.id }} name={asset.canonical_name} ticker={asset.ticker} size={48} />
      <div className={styles.cardTitle}>
        <Link href={page} className={styles.stretch}><strong>{asset.canonical_name}</strong></Link>
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
    </> : <div className={styles.cardActions}>
      <Link href={page} className={ui.secondary}>Open page</Link>
      {canRun && <Link href={researchHrefFor(asset)} className={ui.primary}>Run research</Link>}
    </div>}
  </article>;
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
