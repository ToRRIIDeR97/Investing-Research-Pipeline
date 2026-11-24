"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { QuantView, type QuantTab } from "@/components/quant/quant-view";
import styles from "@/components/quant/quant.module.css";
import type { QuantSnapshot } from "@/lib/api/quant";

/** /quant/:ticker — PragValue and PragTrend for one ticker (Implementations/quant-page). */
export default function QuantTickerPage() {
  const { ticker } = useParams<{ ticker: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tab: QuantTab = params.get("tab") === "trend" ? "trend" : "value";
  const [snapshot, setSnapshot] = useState<QuantSnapshot | null>(null);
  const [error, setError] = useState("");
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

  const refresh = async () => {
    setRefreshing(true);
    try { setSnapshot(await fetchSnapshot(true)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRefreshing(false); }
  };

  const setTab = (next: QuantTab) => router.replace(`/quant/${encodeURIComponent(ticker)}?tab=${next}`, { scroll: false });

  return <div className={ui.page}>
    {error ? <p className={styles.state} role="alert">{error}</p>
      : !snapshot ? <p className={styles.state} aria-busy="true">Computing PragValue and PragTrend for {decodeURIComponent(ticker).toUpperCase()}… The first look-up of a ticker fetches its filings and prices.</p>
      : <QuantView snapshot={snapshot} tab={tab} onTab={setTab} onRefresh={() => void refresh()} refreshing={refreshing} />}
  </div>;
}
