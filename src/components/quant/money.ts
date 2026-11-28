"use client";
/**
 * Money on the Quant page, in the listing's currency: "$212.40" for USD, "Rp6,000" for IDR, "£4.12" for GBP.
 * The view provides the snapshot's currency through `QuantCurrency`; charts and cards read it with `useMoney`.
 */
import { createContext, useContext } from "react";

export const QuantCurrency = createContext<string>("USD");

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(currency: string, digits: number): Intl.NumberFormat {
  const key = `${currency}:${digits}`;
  let f = formatters.get(key);
  if (!f) {
    try { f = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits }); }
    catch { f = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
    formatters.set(key, f);
  }
  return f;
}

/**
 * A money value with a leading − for negatives. Text keeps two decimals (none from 1,000 up outside USD, where IDR,
 * JPY and KRW prices run to thousands); `compact` (chart labels) drops decimals from 100 up. Pure.
 */
export function formatMoney(v: number | null | undefined, currency = "USD", compact = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const digits = compact ? (a >= 100 ? 0 : 2) : a >= 1000 && currency !== "USD" ? 0 : 2;
  return `${v < 0 ? "−" : ""}${formatter(currency || "USD", digits).format(a)}`;
}

/** `money(v)` in the current snapshot's currency (text style, or chart style with `compact`). */
export function useMoney(compact = false): (v: number | null | undefined) => string {
  const currency = useContext(QuantCurrency);
  return (v) => formatMoney(v, currency, compact);
}
