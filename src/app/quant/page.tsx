"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import ui from "@/components/research-ui.module.css";
import { Card } from "@/components/ui/primitives";
import styles from "@/components/quant/quant.module.css";

/** /quant — look up any ticker's PragValue and PragTrend. */
export default function QuantIndexPage() {
  const router = useRouter();
  const [ticker, setTicker] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const t = ticker.trim().toUpperCase();
    if (t) router.push(`/quant/${encodeURIComponent(t)}`);
  };
  return <div className={ui.page}>
    <Card title="Quant">
      <p className={styles.caption}>PragValue and PragTrend for any US-listed stock, computed from its filings and daily prices. No research run and no model calls.</p>
      <form className={styles.search} onSubmit={submit}>
        <label className={styles.srOnly} htmlFor="quant-ticker">Ticker</label>
        <input id="quant-ticker" value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="Ticker, e.g. AAPL" autoComplete="off" />
        <button type="submit" className={ui.primary}>Open</button>
      </form>
    </Card>
  </div>;
}
