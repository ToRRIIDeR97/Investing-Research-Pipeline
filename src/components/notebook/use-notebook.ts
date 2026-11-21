"use client";
import { useCallback, useEffect, useState } from "react";
import type { Notebook, NotebookKind } from "@/lib/research/notebook/contracts";

const EMPTY: Notebook = { pins: [], kpis: [], annotations: [], journal: [] };

/** Error text from a failed notebook request: the route's message, or its first validation problem. */
async function failure(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string; details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> } } | null;
  const field = body?.details?.fieldErrors ? Object.values(body.details.fieldErrors).flat()[0] : undefined;
  return body?.details?.formErrors?.[0] ?? field ?? body?.error ?? `Request failed (${response.status})`;
}

/** The asset's notebook, with create, update and delete helpers that reload it afterwards. */
export function useNotebook(assetId: string | null) {
  const [notebook, setNotebook] = useState<Notebook>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = assetId ? `/api/assets/${assetId}/notebook` : null;

  const reload = useCallback(async () => {
    if (!base) return;
    const response = await fetch(base, { cache: "no-store" });
    if (!response.ok) { setError(await failure(response)); return; }
    setNotebook(await response.json());
    setLoaded(true);
  }, [base]);
  useEffect(() => { setNotebook(EMPTY); setLoaded(false); void reload(); }, [reload]);

  const send = useCallback(async (url: string, method: string, body?: unknown): Promise<boolean> => {
    setError(null);
    const response = await fetch(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    if (!response.ok) { setError(await failure(response)); return false; }
    await reload();
    return true;
  }, [reload]);
  const create = useCallback((kind: NotebookKind, body: unknown) => base ? send(`${base}/${kind}`, "POST", body) : Promise.resolve(false), [base, send]);
  const update = useCallback((kind: NotebookKind, id: string, body: unknown) => base ? send(`${base}/${kind}/${id}`, "PATCH", body) : Promise.resolve(false), [base, send]);
  const remove = useCallback((kind: NotebookKind, id: string) => base ? send(`${base}/${kind}/${id}`, "DELETE") : Promise.resolve(false), [base, send]);
  return { notebook, loaded, error, setError, reload, create, update, remove };
}
export type NotebookApi = ReturnType<typeof useNotebook>;
