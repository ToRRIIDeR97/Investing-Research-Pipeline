"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { QuantView, parseQuantTab, type QuantTab } from "@/components/quant/quant-view";
import { QuantSearch, quantHref } from "@/components/quant/quant-search";
import { CompanyLogo } from "@/components/company/company";
import { PageLoading, StepProgress, type LoadingStep } from "@/components/ui/loading";
import styles from "@/components/quant/quant.module.css";
import type { QuantSnapshot } from "@/lib/api/quant";
import type { FinderResult } from "@/lib/quant/directory";

/** A first look-up's typical stages (seconds); one request does them all, so the card follows these timings. */
const FIRST_LOOKUP: LoadingStep[] = [
  { label: "Finding the company", seconds: 3 },
  { label: "Reading its annual statements", seconds: 7 },
  { label: "Fetching five years of daily prices", seconds: 6 },
  { label: "Computing PragValue and PragTrend", seconds: 10 },
];

/** /quant/:ticker — PragValue and PragTrend for one ticker (Implementations/quant-page). */
export default function QuantTickerPage() {
  const { ticker } = useParams<{ ticker: string }>();
  let key = ticker;
  try { key = decodeURIComponent(ticker).trim().toUpperCase(); } catch { /* malformed: keyed as typed */ }
  // useSearchParams needs a Suspense boundary so the route can prerender its shell. Keyed by ticker, so moving to
  // another ticker starts from the loading state instead of showing the previous company's snapshot.
  return <Suspense fallback={<div className={ui.page}><PageLoading shape="quant" label="Loading" /></div>}>
    <QuantTicker key={key} ticker={ticker} />
  </Suspense>;
}

/** Other listings for a ticker that didn't resolve (BBCA is a US ETF; BBCA.JK the bank). */
function Suggestions({ query, exclude }: { query: string; exclude: string }) {
  const [results, setResults] = useState<FinderResult[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/quant-finder?q=${encodeURIComponent(query.replace(/\.[A-Z]{1,3}$/, ""))}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setResults((Array.isArray(d?.results) ? d.results as FinderResult[] : []).filter((r) => r.ticker !== exclude).slice(0, 5)); })
      .catch(() => { if (alive) setResults([]); });
    return () => { alive = false; };
  }, [query, exclude]);
  if (!results?.length) return null;
  return <div className={styles.suggest}>
    <p>Did you mean</p>
    <ul>{results.map((r) => <li key={r.ticker}><Link href={quantHref(r.ticker)}>
      <CompanyLogo subject={null} name={r.name} ticker={r.ticker} size={26} /><span>{r.name}</span><b>{r.ticker}{r.exchange ? ` · ${r.exchange}` : ""}</b>
    </Link></li>)}</ul>
  </div>;
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
    {snapshot ? <QuantView snapshot={snapshot} tab={tab} onTab={setTab} onRefresh={() => void refresh()} refreshing={refreshing} refreshError={refreshError} onDismissError={() => setRefreshError("")}
      search={<QuantSearch compact placeholder="Search another stock" id="quant-page-search" />} />
      : error ? <div className={styles.state}><p role="alert">{error}</p><Suggestions query={label} exclude={label} /><Link href="/quant">Look up another ticker</Link></div>
      // A cached ticker answers in well under the skeleton's 300 ms delay, so the steps only show for a real first look-up.
      : <PageLoading shape="quant" label={`Computing PragValue and PragTrend for ${label}`}>
        <StepProgress title={label} subtitle="First look-up today · usually 20–40 s" steps={FIRST_LOOKUP}
          badge={<CompanyLogo subject={null} name={label} ticker={label} size={40} />} />
      </PageLoading>}
  </div>;
}
