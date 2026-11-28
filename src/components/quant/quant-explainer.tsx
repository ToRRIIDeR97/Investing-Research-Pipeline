/**
 * What PragValue and PragTrend are, how they are built and how to read them (workshop quant-intl-round, D1). Shown
 * on the finder and behind "About PragValue" / "About PragTrend" on the ticker page. Plain words; each key term has
 * a one-line definition on hover and for screen readers.
 */
import styles from "./finder.module.css";

type Part = { what: string; how: string; read: string; terms: [term: string, meaning: string][] };

export const EXPLAIN: Record<"value" | "trend", Part> = {
  value: {
    what: "An estimate of what one share is worth in three cases (bear, base and bull), and a grade for how cheap or expensive the stock is against that estimate.",
    how: "The company is routed to one of eight valuation engines by what it does: banks on book value and returns, miners across the commodity cycle, growers on sales, most others on operating profit. The engine projects five years of its cash-flow metrics from the company's own filings (SEC, or Yahoo Finance outside the US), values year five at exit multiples from the company's own history, discounts back to today and takes the weighted median across metrics.",
    read: "The tiles show each case's value against today's price: green means the case is worth more than the price. PQ Grade, A to F, weighs that gap together with how much the stock could gain against how much it could lose. PulseScore runs from −3 (expensive) to +3 (cheap). You can change each case's growth to see what you'd have to believe.",
    terms: [
      ["DCF", "Discounted cash flow: future cash flows and an exit value, discounted back to today."],
      ["Exit multiple", "The multiple (for example price to free cash flow) the company is valued at in year five."],
      ["PQ Grade", "A to F: value gap and upside versus downside together."],
      ["PulseScore", "−3 to +3: how far the base case is above or below today's price."],
    ],
  },
  trend: {
    what: "Whether the share price is in a healthy uptrend, from daily closing prices only, measured against the market.",
    how: "Nine trend-template rules (price above its 50, 150 and 200-day averages, the averages stacked and rising, near its 52-week high and well off its low), the Weinstein stage from the 30-week average, and relative strength against the S&P 500 (or the exchange's main index outside the US) and the sector fund.",
    read: "More rules met is a stronger trend. Stage 2 is advancing and stage 4 declining; 1 and 3 are bases and tops. An RS rating above 70 means it beat most of the market over the past year. Pocket pivots are up days on unusually heavy volume.",
    terms: [
      ["Trend template", "Nine price-and-average rules a stock in a strong uptrend usually meets."],
      ["Weinstein stage", "1 basing, 2 advancing, 3 topping, 4 declining, from the 30-week average."],
      ["RS rating", "1 to 99: performance over the year against the benchmark; 70 or more passes."],
      ["Pocket pivot", "An up day whose volume beats every down day's in the last ten sessions."],
    ],
  },
};

export function QuantExplainer({ kind }: { kind: "value" | "trend" }) {
  const e = EXPLAIN[kind];
  return <div className={styles.explainer}>
    <div><h3>What it is</h3><p>{e.what}</p></div>
    <div><h3>How it&apos;s built</h3><p>{e.how}</p></div>
    <div><h3>How to read it</h3><p>{e.read}</p></div>
    <div className={styles.terms} aria-label="Key terms">
      {e.terms.map(([t, m]) => <dfn key={t} title={m}>{t}<span className={styles.srOnly}>: {m}</span></dfn>)}
    </div>
  </div>;
}
