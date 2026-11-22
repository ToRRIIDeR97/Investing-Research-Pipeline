"use client";
// Asset cards and rows for the home feed, the Research list and the review queue: logo, name, stage, key numbers.
import Link from "next/link";
import type { AssetOverview } from "@/lib/research/asset-overview";
import { CompanyLogo } from "@/components/company/company";
import { MiniRuler, money, signedPercent } from "@/components/visuals/valuation-visuals";
import ui from "@/components/research-ui.module.css";
import styles from "./asset-cards.module.css";

export type { AssetOverview };
export const words = (value?: string | null) => value ? value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "";
export const kindLabel = (kind: string) => kind.replace(/_asset/g, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Where an asset stands, in the words of the research river. Any run of it in the review queue means "needs your
 *  decision", even when a newer run exists. */
export function stageOf(asset: AssetOverview, reviewing?: ReadonlySet<string>): { key: string; label: string; tone: string } {
  if (reviewing?.has(asset.id)) return { key: "review", label: "Needs your decision", tone: "waiting_for_human" };
  const status = asset.latest_run?.status;
  if (!status) return { key: "idea", label: "Not started", tone: "" };
  if (["queued", "pending", "running", "planning"].includes(status)) return { key: "running", label: "Researching", tone: "running" };
  if (status === "waiting_for_human") return { key: "review", label: "Needs your decision", tone: "waiting_for_human" };
  if (status === "needs_more_work") return { key: "rework", label: "Needs more work", tone: "needs_more_work" };
  if (["completed", "approved"].includes(status)) return { key: "done", label: "Decided", tone: "completed" };
  if (["failed", "cancelled"].includes(status)) return { key: "stopped", label: words(status), tone: status };
  return { key: "running", label: words(status), tone: status };
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
      <span className={ui.status} data-status={stage.tone}>{stage.label}</span>
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
    <span className={ui.status} data-status={stage.tone}>{stage.label}</span>
    <span className={styles.rowValue}>{s?.values.base != null ? <>{money(s.values.base, s.currency)}<em data-tone={s.gap.base != null && s.gap.base < 0 ? "bad" : "good"}>{signedPercent(s.gap.base)}</em></> : <em>—</em>}</span>
  </Link>;
}
