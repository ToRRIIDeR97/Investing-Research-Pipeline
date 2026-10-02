// Minimal inline-XBRL builders for the live-run-repair acceptance tests.
export const docId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const header = (year: number, focus: string, end: string, contexts: string) =>
  `<ix:nonNumeric name="dei:DocumentFiscalYearFocus">${year}</ix:nonNumeric>` +
  `<ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">${focus}</ix:nonNumeric>` +
  `<ix:nonNumeric name="dei:DocumentPeriodEndDate">${end}</ix:nonNumeric>` +
  `<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>` +
  `<xbrli:unit id="eps"><xbrli:unitNumerator><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:unit>` +
  contexts;

export const context = (id: string, start: string, end: string) =>
  `<xbrli:context id="${id}"><xbrli:period>${start
    ? `<xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate>`
    : `<xbrli:instant>${end}</xbrli:instant>`}</xbrli:period></xbrli:context>`;

export const fact = (ctx: string, name: string, value: string, unit = "usd") =>
  `<ix:nonFraction id="${ctx}-${name.replace(/\W/g, "")}" name="${name}" contextRef="${ctx}" unitRef="${unit}" scale="6" format="ixt:numdotdecimal">${value}</ix:nonFraction>`;

export const row = (label: string, ...cells: string[]) =>
  `<tr><td>${label}</td>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;

export const table = (...rows: string[]) => `<div><table>${rows.join("")}</table></div>`;
export const spacer = `<div><table><tbody><tr><td></td><td></td></tr></tbody></table></div>`;
export const text = (value: string) => `<div><span>${value}</span></div>`;

export const source = (id: string, published: string, periodEnd: string, form = "10-Q") =>
  ({ id, url: `https://www.sec.gov/${id}`, published_at: published, period_end: periodEnd, metadata_json: { form } });

/** A quarter filing with all three primary statements tagged with us-gaap concepts. */
export function standardStatements(prefix: (name: string) => string) {
  return [
    prefix("Balance Sheets"),
    table(row("Total assets", fact("i", "us-gaap:Assets", "500")), row("Total liabilities", fact("i", "us-gaap:Liabilities", "300")),
      row("Total equity", fact("i", "us-gaap:StockholdersEquity", "200"))),
    prefix("Statements of Income"),
    table(row("Revenue", fact("q", "us-gaap:Revenues", "90")), row("Net income", fact("q", "us-gaap:NetIncomeLoss", "9")),
      row("EPS", fact("q", "us-gaap:EarningsPerShareBasic", "1.5", "eps"))),
    prefix("Statements of Cash Flows"),
    table(row("Operating", fact("q", "us-gaap:NetCashProvidedByUsedInOperatingActivities", "20")),
      row("Investing", fact("q", "us-gaap:NetCashProvidedByUsedInInvestingActivities", "-5")),
      row("Financing", fact("q", "us-gaap:NetCashProvidedByUsedInFinancingActivities", "-3"))),
  ].join("");
}
