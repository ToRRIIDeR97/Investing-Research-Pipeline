"use client";

import { useCallback, useEffect, useState } from 'react';
import type { SavedChart, SavedChartDefinition } from '@/lib/research/reporting/saved-charts';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

/** Saved charts for the My charts board, shared across assets. */
export function useSavedCharts() {
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    request<SavedChart[]>('/api/saved-charts')
      .then((list) => { if (live) { setCharts(list); setError(null); } })
      .catch((e: Error) => { if (live) setError(`Saved charts could not be loaded: ${e.message}`); })
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, []);
  const create = useCallback(async (name: string, definition: SavedChartDefinition) => {
    const chart = await request<SavedChart>('/api/saved-charts', { method: 'POST', body: JSON.stringify({ name, definition }) });
    setCharts((list) => [...list, chart]);
    return chart;
  }, []);
  const update = useCallback(async (id: string, changes: { name?: string; definition?: SavedChartDefinition }) => {
    const chart = await request<SavedChart>(`/api/saved-charts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    setCharts((list) => list.map((c) => (c.id === id ? chart : c)));
    return chart;
  }, []);
  const remove = useCallback(async (id: string) => {
    await request<void>(`/api/saved-charts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setCharts((list) => list.filter((c) => c.id !== id));
  }, []);
  return { charts, loaded, error, create, update, remove };
}

export type SavedChartsApi = ReturnType<typeof useSavedCharts>;
