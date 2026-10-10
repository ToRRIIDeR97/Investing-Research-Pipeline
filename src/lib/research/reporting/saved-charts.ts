import { z } from 'zod';
import { MAX_SERIES } from './chart-series';

/**
 * Saved chart definitions. A definition names line-item or metric keys, never values, so a
 * saved chart refills with whichever asset's Financials view shows it. Names are untrusted
 * text: control characters are removed and the UI renders them as plain text only.
 */
export const savedChartName = z.string()
  .transform((s) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Name the chart').max(120));

export const savedChartSeries = z.object({
  key: z.string().min(1).max(200).regex(/^(metric:)?[A-Za-z][A-Za-z0-9_]*$/, 'Unknown series key'),
  as: z.enum(['bar', 'line']),
  axis: z.enum(['left', 'right']),
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
