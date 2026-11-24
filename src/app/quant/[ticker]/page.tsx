"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { QuantView, parseQuantTab, type QuantTab } from "@/components/quant/quant-view";
import styles from "@/components/quant/quant.module.css";
import type { QuantSnapshot } from "@/lib/api/quant";

/** /quant/:ticker — PragValue and PragTrend for one ticker (Implementations/quant-page). */
export default function QuantTickerPage() {
  const { ticker } = useParams<{ ticker: string }>();
  let key = ticker;
  try { key = decodeURIComponent(ticker).trim().toUpperCase(); } catch { /* malformed: keyed as typed */ }
  // useSearchParams needs a Suspense boundary so the route can prerender its shell. Keyed by ticker, so moving to
  // another ticker starts from the loading state instead of showing the previous company's snapshot.
  return <Suspense fallback={<div className={ui.page}><p className={styles.state} role="status">Loading…</p></div>}>
    <QuantTicker key={key} ticker={ticker} />
  </Suspense>;
}

function QuantTicker({ ticker }: { ticker: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const tab: QuantTab = parseQuantTab(params.get("tab"));
  const [snapshot, setSnapshot] = useState<QuantSnapshot | null>(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const fetchSnapshot = useCallback(async (refresh: boolean): Promise<QuantSnapshot> => {
    const response = await fetch(`/api/quant/${encodeURIComponent(ticker)}${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
    return body;
  }, [ticker]);

  useEffect(() => {
    let alive = true;
    fetchSnapshot(false)
      .then((s) => { if (alive) { setSnapshot(s); setError(""); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [fetchSnapshot]);

  // A failed refresh keeps the snapshot on screen and reports the failure beside it.
  const refresh = async () => {
    setRefreshing(true);
    try { setSnapshot(await fetchSnapshot(true)); setRefreshError(""); }
    catch (e) { setRefreshError(e instanceof Error ? e.message : String(e)); }
    finally { setRefreshing(false); }
  };

  const setTab = (next: QuantTab) => router.replace(`/quant/${encodeURIComponent(ticker)}?tab=${next}`, { scroll: false });
  let label = ticker;
  try { label = decodeURIComponent(ticker).toUpperCase(); } catch { /* shown as typed */ }

  return <div className={ui.page}>
    {snapshot ? <QuantView snapshot={snapshot} tab={tab} onTab={setTab} onRefresh={() => void refresh()} refreshing={refreshing} refreshError={refreshError} onDismissError={() => setRefreshError("")} />
      : error ? <div className={styles.state}><p role="alert">{error}</p><Link href="/quant">Look up another ticker</Link></div>
      : <p className={styles.state} role="status" aria-busy="true">Computing PragValue and PragTrend for {label}… The first look-up of a ticker fetches its filings and prices.</p>}
  </div>;
}
