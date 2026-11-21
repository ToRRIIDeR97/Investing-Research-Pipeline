/**
 * The workbench form's draft: every editable input as the text the operator typed, keyed by where it goes
 * (`set.<set>.<field>`, `driver.<case>.<year>.<field>`, `prob.<case>`). Rates are shown in percent, fade years as
 * whole years. `draftChange` turns a draft into the typed `WorkbenchChange` holding only what differs from the stored
 * inputs; `draftFromChange` does the reverse, for loading a saved scenario or applying a chat proposal. Pure.
 */
import type { WorkbenchChange } from "./whatif";

type Case = "bear" | "base" | "bull";
type SetKey = "conservative" | "base" | "aggressive";
type SetField = "discount_rate" | "terminal_growth" | "ronic" | "fade_years";
type DriverField = "revenue_growth" | "operating_margin";
export type WorkbenchInputs = {
  sets: { set: SetKey; discount_rate: number; terminal_growth: number; ronic: number; fade_years: number }[];
  probabilities: Record<Case, number>;
  drivers: Record<Case, { fiscal_year: number; revenue_growth: number; operating_margin: number }[]>;
};
export type Draft = Record<string, string>;

export const CASES: Case[] = ["bear", "base", "bull"];
export const SET_FIELDS: SetField[] = ["discount_rate", "terminal_growth", "ronic", "fade_years"];
export const DRIVER_FIELDS: DriverField[] = ["revenue_growth", "operating_margin"];

const pct = (n: number) => String(Number((n * 100).toFixed(2)));
const shown = (field: SetField, n: number) => field === "fade_years" ? String(n) : pct(n);
/** Text → the stored unit (decimals for rates), or NaN when it is not a number. */
const parse = (field: string, text: string) => {
  const t = text.trim();
  if (t === "" || !Number.isFinite(Number(t))) return NaN;
  return field === "fade_years" ? Number(t) : Number((Number(t) / 100).toFixed(6));
};
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export function draftFromInputs(inputs: WorkbenchInputs): Draft {
  const draft: Draft = {};
  for (const set of inputs.sets) for (const field of SET_FIELDS) draft[`set.${set.set}.${field}`] = shown(field, set[field]);
  for (const c of CASES) {
    draft[`prob.${c}`] = pct(inputs.probabilities[c]);
    for (const year of inputs.drivers[c] ?? []) for (const field of DRIVER_FIELDS) draft[`driver.${c}.${year.fiscal_year}.${field}`] = pct(year[field]);
  }
  return draft;
}

export function draftFromChange(inputs: WorkbenchInputs, change: WorkbenchChange): Draft {
  const draft = draftFromInputs(inputs);
  for (const [set, over] of Object.entries(change.sets ?? {})) for (const [field, value] of Object.entries(over ?? {}))
    if (typeof value === "number" && `set.${set}.${field}` in draft) draft[`set.${set}.${field}`] = shown(field as SetField, value);
  for (const [c, years] of Object.entries(change.drivers ?? {})) for (const year of years ?? []) for (const field of DRIVER_FIELDS) {
    const value = year[field];
    if (typeof value === "number" && `driver.${c}.${year.fiscal_year}.${field}` in draft) draft[`driver.${c}.${year.fiscal_year}.${field}`] = pct(value);
  }
  if (change.probabilities) for (const c of CASES) draft[`prob.${c}`] = pct(change.probabilities[c]);
  return draft;
}

/** The change a draft makes, or the first input that is not a number. */
export function draftChange(inputs: WorkbenchInputs, draft: Draft): { change: WorkbenchChange; error: null } | { change: null; error: string } {
  const change: WorkbenchChange = {};
  // Compared with the stored inputs as shown, so rounding for display is not a change; an unchanged input keeps the
  // exact stored value.
  const shownInputs = draftFromInputs(inputs);
  const changed = (key: string, field: string, value: number) => !same(value, parse(field, shownInputs[key] ?? ""));
  for (const set of inputs.sets) for (const field of SET_FIELDS) {
    const value = parse(field, draft[`set.${set.set}.${field}`] ?? "");
    if (Number.isNaN(value)) return { change: null, error: `The ${set.set} set's ${field.replace(/_/g, " ")} must be a number.` };
    if (changed(`set.${set.set}.${field}`, field, value)) ((change.sets ??= {})[set.set] ??= {})[field] = value;
  }
  for (const c of CASES) for (const year of inputs.drivers[c] ?? []) {
    const edit: { fiscal_year: number; revenue_growth?: number; operating_margin?: number } = { fiscal_year: year.fiscal_year };
    for (const field of DRIVER_FIELDS) {
      const value = parse(field, draft[`driver.${c}.${year.fiscal_year}.${field}`] ?? "");
      if (Number.isNaN(value)) return { change: null, error: `The ${c} case's FY${year.fiscal_year} ${field.replace(/_/g, " ")} must be a number.` };
      if (changed(`driver.${c}.${year.fiscal_year}.${field}`, field, value)) edit[field] = value;
    }
    if (Object.keys(edit).length > 1) ((change.drivers ??= {})[c] ??= []).push(edit);
  }
  const probabilities = Object.fromEntries(CASES.map((c) => [c, parse("probability", draft[`prob.${c}`] ?? "")])) as Record<Case, number>;
  if (CASES.some((c) => Number.isNaN(probabilities[c]))) return { change: null, error: "Each case probability must be a number." };
  if (CASES.some((c) => changed(`prob.${c}`, "probability", probabilities[c]))) change.probabilities = probabilities;
  return { change, error: null };
}
