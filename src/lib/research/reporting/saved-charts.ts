import { z } from 'zod';
import { MAX_SERIES, parseSumKey } from './chart-series';

/**
 * Saved chart definitions. A definition names line-item or metric keys, never values, so a
 * saved chart refills with whichever asset's Financials view shows it. Names are untrusted
 * text: control characters are removed and the UI renders them as plain text only.
 */
const plainText = (max: number, empty: string) => z.string()
  .transform((s) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, empty).max(max));

export const savedChartName = plainText(120, 'Name the chart');

/** A line item, a catalogue metric, or a sum of two to six of them (`sum:+a-b`). */
export const savedChartSeries = z.object({
  key: z.string().min(1).max(800).refine((k) => /^(metric:)?[A-Za-z][A-Za-z0-9_]*$/.test(k) || parseSumKey(k) !== null, 'Unknown series key'),
  as: z.enum(['bar', 'line']),
  axis: z.enum(['left', 'right']),
  /** The name of a summed series; untrusted text, shown as plain text only. */
  label: plainText(80, 'Name the total').optional(),
}).strict();

export const savedChartDefinition = z.object({
  series: z.array(savedChartSeries).min(1).max(MAX_SERIES)
    .refine((s) => new Set(s.map((x) => x.key)).size === s.length, 'A series can appear only once'),
  chart_type: z.enum(['bars', 'stacked', 'lines']),
  frequency: z.enum(['quarterly', 'annual']),
  range: z.enum(['last_4', 'last_8', 'last_12', 'all']),
  mode: z.enum(['values', 'yoy']),
}).strict();

export const createSavedChart = z.object({ name: savedChartName, definition: savedChartDefinition }).strict();
export const updateSavedChart = z.object({ name: savedChartName.optional(), definition: savedChartDefinition.optional() }).strict()
  .refine((v) => v.name !== undefined || v.definition !== undefined, 'Nothing to update');

export type SavedChartDefinition = z.infer<typeof savedChartDefinition>;
export type SavedChart = { id: string; name: string; definition: SavedChartDefinition; created_at: string; updated_at: string };
