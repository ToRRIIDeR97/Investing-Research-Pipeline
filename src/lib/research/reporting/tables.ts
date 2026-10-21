import type { ReportSection } from "./contracts";
import type { ReportArtifact } from "./report";

export function resolveTable(table: ReportSection["tables"][number], artifacts: ReportArtifact[]): unknown {
  const artifact = artifacts.find(a => a.id === table.artifact_id);
  if (!artifact) throw new Error(`Unknown table artifact ${table.artifact_id}`);
  let value: any = artifact.content_json;
  // Paths start inside content_json; writers sometimes name the field itself, which is the same place.
  const path = table.path?.replace(/^content_json(?:\.|$)/, "");
  for (const part of path ? path.split(".") : []) {
    if (["__proto__", "constructor", "prototype"].includes(part) || value == null || !Object.hasOwn(value, part)) {
      throw new Error(`Unknown table path ${table.path}`);
    }
    value = value[part];
  }
  return value;
}

/** Most rows a report table may print; a longer series belongs in Financials or a chart. */
export const MAX_TABLE_ROWS = 60;

export type TableCell = string | number | boolean | null;
export interface FlatTable { rows: Record<string, TableCell>[]; notes: string[] }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isCell = (value: unknown): value is TableCell => value === null || ["string", "number", "boolean"].includes(typeof value);

/** A computed valuation schedule (calculateValuationSchedule): yearly rows plus its totals. */
const isSchedule = (value: unknown): value is { years: unknown[] } & Record<string, unknown> =>
  isRecord(value) && Array.isArray(value.years) && typeof value.value_per_share === "number";

/** A list of plain values (claim IDs, mitigants) prints as one cell. */
const isCellList = (value: unknown): value is TableCell[] => Array.isArray(value) && value.every(isCell);
const cellOf = (value: unknown): TableCell | undefined =>
  value === undefined ? null : isCell(value) ? value : isCellList(value) ? value.map((item) => String(item)).join("; ") : undefined;

/**
 * The nearest list of records under a record, as a path suffix the writer can request instead. Only records are
 * searched, never a list's items, so the suggestion is a table, not a field inside one row.
 */
function arrayChild(value: unknown, prefix = ""): string | null {
  if (!isRecord(value)) return null;
  const path = (key: string) => (prefix ? `${prefix}.${key}` : key);
  for (const [key, child] of Object.entries(value)) {
    if ((Array.isArray(child) && child.length && child.every(isRecord)) || isYearKeyed(child)) return path(key);
  }
  for (const [key, child] of Object.entries(value)) {
    const found = arrayChild(child, path(key));
    if (found) return found;
  }
  return null;
}

/**
 * A record with values one level deep at most, as flat columns ("build.capital_expenditures"); a list of plain
 * values is one joined cell. Anything deeper is rejected.
 */
function flatRow(row: Record<string, unknown>): Record<string, TableCell> | null {
  const flat: Record<string, TableCell> = {};
  for (const [key, value] of Object.entries(row)) {
    const direct = cellOf(value);
    if (direct !== undefined) { flat[key] = direct; continue; }
    if (!isRecord(value)) return null;
    for (const [sub, inner] of Object.entries(value)) {
      const nested = cellOf(inner);
      if (nested === undefined) return null;
      flat[`${key}.${sub}`] = nested;
    }
  }
  return flat;
}

/** A record keyed by fiscal year whose values are records (scenario statements by year). */
const isYearKeyed = (value: unknown): value is Record<string, Record<string, unknown>> =>
  isRecord(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, row]) => /^\d{4}$/.test(key) && isRecord(row));

/**
 * The rows a report table prints, or an error the section writer can act on. A table is a { columns, rows } table,
 * a valuation schedule (its years, with the totals as a note), an array of records whose values are at most one
 * level deep, or a single such record. Anything deeper names the nearest array to request instead, and a table
 * longer than MAX_TABLE_ROWS is rejected.
 */
export function flatTable(table: ReportSection["tables"][number], artifacts: ReportArtifact[]): FlatTable {
  let value = resolveTable(table, artifacts);
  const where = `Table "${table.title}" (${table.artifact_id} ${table.path || "root"})`;
  const notes: string[] = [];
  const columnar = value as { columns?: unknown; rows?: unknown };
  if (isRecord(columnar) && Array.isArray(columnar.columns) && Array.isArray(columnar.rows) && columnar.rows.every(Array.isArray)) {
    const columns = columnar.columns as string[];
    value = (columnar.rows as unknown[][]).map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  } else if (isSchedule(value)) {
    const schedule = value;
    notes.push(["terminal_value", "terminal_present_value", "equity_value", "value_per_share"]
      .filter(key => typeof schedule[key] === "number").map(key => `${key}: ${schedule[key]}`).join("; "));
    value = schedule.years;
  } else if (isYearKeyed(value)) {
    value = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([year, row]) => ({ fiscal_year: Number(year), ...row }));
  }
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length > MAX_TABLE_ROWS) throw new Error(`${where} has ${rows.length} rows; a report table holds at most ${MAX_TABLE_ROWS}. Request a summary table (financial_analytics) or a chart instead.`);
  const flat = rows.map(row => isCell(row) || isCellList(row) ? { Value: cellOf(row)! } : isRecord(row) ? (isSchedule(row) ? null : flatRow(row)) : null);
  if (flat.some(row => row === null)) {
    // A list of valuation schedules is requested one schedule at a time; anything else at its nearest array.
    const schedule = rows.findIndex(isSchedule);
    const child = schedule >= 0 ? String(schedule) : Array.isArray(value) ? null : arrayChild(value);
    const suggestion = child ? ` Request ${[table.path, child].filter(Boolean).join(".")} instead.` : "";
    throw new Error(`${where} is not a list of flat rows: its values nest more than one level.${suggestion}`);
  }
  return { rows: flat as Record<string, TableCell>[], notes: notes.filter(Boolean) };
}
