"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { Card } from "@/components/ui/primitives";
import styles from "@/components/quant/quant.module.css";
import { TICKER_PATTERN } from "@/lib/quant/ticker";

/** /quant — look up any ticker's PragValue and PragTrend. */
export default function QuantIndexPage() {
  const router = useRouter();
  const [ticker, setTicker] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const t = ticker.trim().toUpperCase();
    if (!TICKER_PATTERN.test(t)) { setInvalid(true); return; }
    router.push(`/quant/${encodeURIComponent(t)}`);
  };
  return <div className={ui.page}>
    <Card title="Quant">
      <p className={styles.caption}>PragValue and PragTrend for any US-listed stock, computed from its filings and daily prices. No research run and no model calls.</p>
      <form className={styles.search} onSubmit={submit} noValidate>
        <label className={styles.srOnly} htmlFor="quant-ticker">Ticker</label>
        <input id="quant-ticker" value={ticker} onChange={(e) => { setTicker(e.target.value); setInvalid(false); }} placeholder="Ticker, e.g. AAPL"
          autoComplete="off" aria-invalid={invalid} aria-describedby={invalid ? "quant-ticker-error" : undefined} />
        <button type="submit" className={ui.primary}>Open</button>
      </form>
      {invalid && <p id="quant-ticker-error" className={styles.unavailable} role="alert">Enter a ticker symbol: a letter, then up to nine letters, digits, dots or dashes (for example BRK-B).</p>}
    </Card>
  </div>;
}
