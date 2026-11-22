"use client";
// Company profiles in the browser: every logo and leadership block on a page asks through this one store, which
// batches the asks into POST /api/company-profiles calls (40 at most) and asks again for keys the server is still
// looking up. Profiles are display data only; a missing one renders as a monogram.
import { useSyncExternalStore } from "react";

export interface CompanyPerson { name: string; role: string; photo_url: string | null; page_url: string | null }
export interface CompanyProfile { key: string; name: string; wikidata_id: string | null; logo_url: string | null; website: string | null; wikipedia_url: string | null; people: CompanyPerson[] }
export type ProfileSubject = { asset_id: string } | { name: string; ticker?: string | null; kind?: string | null };
/** `throttled`: the server is still looking this company up without WIKIMEDIA_CONTACT, about 30 s a company. */
export interface ProfileState { profile: CompanyProfile | null; loading: boolean; throttled: boolean }
/** The quiet note shown where a logo or leadership is still loading slowly. */
export const SLOW_LOOKUP_NOTE = "Still looking up this company. Wikimedia lookups are unidentified, about 30 seconds a company; "
  + "the operator can set WIKIMEDIA_CONTACT to speed them up (docs/operations.md).";

const subjectId = (s: ProfileSubject) => "asset_id" in s ? `asset:${s.asset_id}` : `co:${(s.ticker ?? "").toUpperCase()}|${s.name.toLowerCase()}`;
const IDLE: ProfileState = { profile: null, loading: false, throttled: false };
const LOADING: ProfileState = { profile: null, loading: true, throttled: false };
const POLL_MS = 7_000;
const MAX_POLLS = 24;

const states = new Map<string, ProfileState>();
const subjects = new Map<string, ProfileSubject>();
const polls = new Map<string, number>();
const listeners = new Set<() => void>();
let queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit() { for (const listener of listeners) listener(); }
function set(id: string, state: ProfileState) { states.set(id, state); }

async function flush() {
  timer = null;
  const ids = [...queued];
  queued = new Set();
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    try {
      const response = await fetch("/api/company-profiles", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjects: batch.map((id) => subjects.get(id)) }) });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json() as { keys: (string | null)[]; profiles: Record<string, CompanyProfile | null>; pending?: string[]; throttled?: boolean };
      const pending = new Set(data.pending ?? []);
      batch.forEach((id, index) => {
        const key = data.keys?.[index];
        const profile = key ? data.profiles?.[key] ?? null : null;
        const waiting = !!key && pending.has(key) && (polls.get(id) ?? 0) < MAX_POLLS;
        set(id, { profile: profile ?? states.get(id)?.profile ?? null, loading: waiting && !profile, throttled: waiting && !profile && data.throttled === true });
        if (waiting) { polls.set(id, (polls.get(id) ?? 0) + 1); setTimeout(() => request(id, true), POLL_MS); }
      });
    } catch {
      for (const id of batch) set(id, { profile: states.get(id)?.profile ?? null, loading: false, throttled: false });
    }
    emit();
  }
}

function request(id: string, again = false) {
  if (!again && states.has(id)) return;
  if (!states.has(id)) set(id, LOADING);
  queued.add(id);
  if (!timer) timer = setTimeout(() => void flush(), 30);
}

/** The profile for one company; null while unknown or when none was found. */
export function useCompanyProfile(subject: ProfileSubject | null): ProfileState {
  const id = subject ? subjectId(subject) : null;
  if (subject && id && !subjects.has(id)) subjects.set(id, subject);
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); if (id) request(id); return () => { listeners.delete(listener); }; },
    () => (id ? states.get(id) ?? LOADING : IDLE),
    () => IDLE,
  );
}
