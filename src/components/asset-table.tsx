import Link from "next/link";
import ui from "@/components/research-ui.module.css";

export interface AssetRow { id: string; canonical_name: string; slug: string; asset_kind: string; sector?: string | null; status?: string | null; }
export const kindLabel = (kind: string) => kind.replace(/_asset/g, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
export const words = (value?: string | null) => value ? value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "";

/** One row per asset: name (opens the research view), ticker, kind, sector, status. */
export function AssetTable({ assets }: { assets: AssetRow[] }) {
  return <div className={ui.table}><table>
    <thead><tr><th>Name</th><th>Slug</th><th>Kind</th><th>Sector</th><th className={ui.num}>Status</th></tr></thead>
    <tbody>{assets.map((asset) => <tr key={asset.id}>
      <td><Link href={`/assets/${asset.id}/view`} className="font-medium hover:underline">{asset.canonical_name}</Link></td>
      <td className={ui.mono}>{asset.slug}</td>
      <td className={ui.muted}>{kindLabel(asset.asset_kind)}</td>
      <td className={ui.muted}>{asset.sector || "—"}</td>
      <td className={ui.num}><span className={ui.status} data-status={asset.status ?? ""}>{words(asset.status) || "—"}</span></td>
    </tr>)}</tbody>
  </table></div>;
}
