/** Money and day formatting shared by the interactive kit. */

const formatters = new Map<string, Intl.NumberFormat>();

/** A price to the cent in its currency ("$14.28"); a code Intl doesn't know falls back to "14.28 XYZ". */
export function money(value: number, currency = "USD"): string {
  const code = (currency || "USD").toUpperCase();
  let f = formatters.get(code);
  if (!f) {
    try { f = new Intl.NumberFormat("en-US", { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    catch { return `${value.toFixed(2)} ${code}`; }
    formatters.set(code, f);
  }
  return f.format(value);
}

/** A whole-dollar amount without cents when it is whole ("$10"), else to the cent. */
export function wholeOrCents(value: number, currency = "USD"): string {
  return Number.isInteger(value) ? money(value, currency).replace(/\.00(?=\D*$)/, "") : money(value, currency);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-05-20" → "20 May 26". */
export function shortDay(day: string): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return day;
  return `${d} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
}
