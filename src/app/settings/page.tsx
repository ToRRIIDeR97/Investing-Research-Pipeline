"use client";
/**
 * Settings: model providers and models (workshop prototype/workshop/quant-intl-round, T1). Two cards: Providers (saved
 * providers, one active, add or edit) and Models (per tier, then per agent in a drawer). Saved to the gitignored
 * .env.settings.local through /api/settings/models; keys are write-only. Research runs take changes from their next job.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import ui from "@/components/research-ui.module.css";
import { Card, Tag } from "@/components/ui/primitives";
import { PageLoading } from "@/components/ui/loading";
import styles from "./settings.module.css";

type View = {
  values: Record<string, string>;
  secrets: Record<string, { set: boolean; last4: string | null }>;
  env: Record<string, string>;
  env_secrets: Record<string, boolean>;
  ignored: boolean;
  /** What each latest:<family> alias in use resolves to with the provider in effect. */
  latest: Record<string, { model: string | null; error?: string }>;
  provider_types: string[];
  efforts: string[];
  agents: string[];
  file: string;
};

const TYPE_NAME: Record<string, string> = {
  "opencode-go-direct": "OpenCode Go",
  "anthropic-direct": "Anthropic",
  "direct-openai-compatible": "OpenAI-compatible",
  "local-openai-compatible": "Local (OpenAI-compatible)",
  mock: "Mock (free, for tests)",
};
const SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const TIERS = [["CHEAP", "Cheap", "Source reading, extraction, routine steps"], ["MID", "Mid", "Analysis and the report"], ["PREMIUM", "Premium", "The hardest judgement calls"]] as const;
const agentKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return ""; } };
const words = (s: string) => s.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

type Draft = { slot: string; label: string; type: string; base_url: string; api_key: string };

export default function SettingsPage() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings/models", { cache: "no-store" });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? "Settings could not be loaded.");
      setView(body); setModels({}); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (set: Record<string, string>, clear: string[], done: string) => {
    setBusy(true); setSaved(""); setError("");
    try {
      const r = await fetch("/api/settings/models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set, clear }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? "Settings could not be saved.");
      setView(body); setModels({}); setSaved(done);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(false); }
  };

  const providers = useMemo(() => {
    if (!view) return [];
    return SLOTS.filter((n) => view.values[`PRAGMA_PROVIDER_${n}_TYPE`]).map((n) => ({
      slot: n, label: view.values[`PRAGMA_PROVIDER_${n}_LABEL`] || TYPE_NAME[view.values[`PRAGMA_PROVIDER_${n}_TYPE`]] || "Provider",
      type: view.values[`PRAGMA_PROVIDER_${n}_TYPE`], base_url: view.values[`PRAGMA_PROVIDER_${n}_BASE_URL`] ?? "",
      key: view.secrets[`PRAGMA_PROVIDER_${n}_API_KEY`] ?? null,
    }));
  }, [view]);

  if (!view) return <div className={ui.page}>
    <header className={ui.heading}><div className={ui.titleGroup}><h1>Settings</h1></div></header>
    {error ? <p className={ui.error} role="alert">{error}<button type="button" onClick={() => void load()}>Try again</button></p> : <PageLoading shape="panel" label="Loading settings" />}
  </div>;

  const active = view.values.PRAGMA_ACTIVE_PROVIDER ?? null;
  const envProvider = view.env.RESEARCH_MODEL_PROVIDER;
  const freeSlot = SLOTS.find((n) => !view.values[`PRAGMA_PROVIDER_${n}_TYPE`]);

  const submitProvider = async (e: FormEvent, use: boolean) => {
    e.preventDefault();
    if (!draft) return;
    const p = `PRAGMA_PROVIDER_${draft.slot}_`;
    const set: Record<string, string> = { [`${p}TYPE`]: draft.type, [`${p}LABEL`]: draft.label.trim() || TYPE_NAME[draft.type] };
    const clear: string[] = [];
    if (draft.type === "mock") clear.push(`${p}BASE_URL`, `${p}ALLOWED_HOSTS`);
    else {
      set[`${p}BASE_URL`] = draft.base_url.trim();
      // A remote provider's host must be allowed explicitly (src/lib/net.ts); a local one runs on loopback.
      if (draft.type !== "local-openai-compatible" && hostOf(draft.base_url)) set[`${p}ALLOWED_HOSTS`] = hostOf(draft.base_url);
    }
    if (draft.api_key.trim()) set[`${p}API_KEY`] = draft.api_key.trim();
    if (use) set.PRAGMA_ACTIVE_PROVIDER = draft.slot;
    if (await save(set, clear, use ? `${set[`${p}LABEL`]} saved and in use.` : `${set[`${p}LABEL`]} saved.`)) setDraft(null);
  };

  const removeProvider = (slot: string) => {
    const p = `PRAGMA_PROVIDER_${slot}_`;
    const clear = ["TYPE", "LABEL", "BASE_URL", "ALLOWED_HOSTS", "API_KEY"].map((f) => p + f);
    if (active === slot) clear.push("PRAGMA_ACTIVE_PROVIDER");
    void save({}, clear, "Provider removed.");
  };

  const modelValue = (key: string) => (key in models ? models[key] : view.values[key] ?? "");
  const setModel = (key: string, value: string) => setModels((m) => ({ ...m, [key]: value }));
  const saveModels = () => {
    const set: Record<string, string> = {}, clear: string[] = [];
    for (const [k, v] of Object.entries(models)) { if (v.trim()) set[k] = v.trim(); else clear.push(k); }
    void save(set, clear, "Models saved.");
  };
  const hint = (key: string) => view.env[key] ? `From your env files: ${view.env[key]}` : "Not set: the agent's default applies";
  /** "latest:haiku is claude-haiku-5-5 now" under a field whose saved or env value is an alias. */
  const resolved = (key: string) => {
    const value = (view.values[key] ?? view.env[key] ?? "").trim();
    const hit = view.latest?.[value];
    if (!hit) return null;
    return <small className={styles.resolved}>{hit.model ? <>Now <code>{hit.model}</code></> : `Not resolved: ${hit.error ?? "unknown error"}`}</small>;
  };

  return <div className={ui.page}>
    <header className={ui.heading}><div className={ui.titleGroup}><h1>Settings</h1></div></header>
    <p className={styles.lede}>The model provider and models research runs use. Saved on this machine in <code>{view.file}</code> (gitignored, next to <code>.env.local</code>); keys are never shown again. A change applies from the next research job, without a restart. Empty fields use your env files.</p>
    {view.ignored && <p className={styles.callout} role="note">This server started on the mock provider, so saved settings are not applied here (they still apply to a worker that isn&apos;t on mock).</p>}
    {error && <p className={ui.error} role="alert">{error}</p>}
    {saved && <p className={styles.saved} role="status">{saved}</p>}

    <div className={styles.grid}>
      <Card title="Providers" action={freeSlot && !draft ? <button type="button" className={ui.secondary} onClick={() => setDraft({ slot: freeSlot, label: "", type: "direct-openai-compatible", base_url: "", api_key: "" })}>Add provider</button> : undefined}>
        <div className={styles.providers} role="radiogroup" aria-label="Provider in use">
          <label className={styles.provider} data-on={!active ? "" : undefined}>
            <input type="radio" name="provider" checked={!active} disabled={busy} onChange={() => void save({}, ["PRAGMA_ACTIVE_PROVIDER"], "Using the provider from your env files.")} />
            <span className={styles.providerText}><strong>From your env files</strong>
              <small>{envProvider ? `${TYPE_NAME[envProvider] ?? envProvider}${view.env.RESEARCH_MODEL_BASE_URL ? ` · ${hostOf(view.env.RESEARCH_MODEL_BASE_URL)}` : ""}` : "No provider set in .env"}</small></span>
          </label>
          {providers.map((p) => <div key={p.slot} className={styles.provider} data-on={active === p.slot ? "" : undefined}>
            <input type="radio" name="provider" aria-label={`Use ${p.label}`} checked={active === p.slot} disabled={busy} onChange={() => void save({ PRAGMA_ACTIVE_PROVIDER: p.slot }, [], `Using ${p.label}.`)} />
            <span className={styles.providerText}><strong>{p.label}</strong>
              <small>{[TYPE_NAME[p.type] ?? p.type, hostOf(p.base_url), p.key ? `key set${p.key.last4 ? ` · …${p.key.last4}` : ""}` : p.type === "mock" || p.type === "local-openai-compatible" ? null : "no key"].filter(Boolean).join(" · ")}</small></span>
            <span className={styles.providerActions}>
              <button type="button" className={ui.textLink} onClick={() => setDraft({ slot: p.slot, label: p.label, type: p.type, base_url: p.base_url, api_key: "" })}>Edit</button>
              <button type="button" className={ui.textLink} onClick={() => removeProvider(p.slot)}>Remove</button>
            </span>
          </div>)}
        </div>

        {draft && <form className={styles.form} onSubmit={(e) => void submitProvider(e, true)} aria-label={view.values[`PRAGMA_PROVIDER_${draft.slot}_TYPE`] ? "Edit provider" : "Add a provider"}>
          <h3>{view.values[`PRAGMA_PROVIDER_${draft.slot}_TYPE`] ? "Edit provider" : "Add a provider"}</h3>
          <div className={styles.row2}>
            <label className={styles.field}><span>Name</span><input value={draft.label} placeholder={TYPE_NAME[draft.type]} maxLength={60} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
            <label className={styles.field}><span>Type</span><select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
              {view.provider_types.map((t) => <option key={t} value={t}>{TYPE_NAME[t] ?? t}</option>)}</select></label>
          </div>
          {draft.type !== "mock" && <label className={styles.field}><span>Base URL</span>
            <input value={draft.base_url} required type="url" placeholder={draft.type === "anthropic-direct" ? "https://api.anthropic.com" : "https://openrouter.ai/api/v1"} onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} />
            <small>{draft.type === "local-openai-compatible" ? "A server on this machine (loopback)." : "Its host is added to the allowed hosts."}</small></label>}
          {draft.type !== "mock" && <label className={styles.field}><span>API key</span>
            <input value={draft.api_key} type="password" autoComplete="off" placeholder={view.secrets[`PRAGMA_PROVIDER_${draft.slot}_API_KEY`] ? "Leave empty to keep the saved key" : "Paste the key"} onChange={(e) => setDraft({ ...draft, api_key: e.target.value })} />
            <small>Stored only in {view.file}; never sent back to this page.</small></label>}
          <div className={styles.actions}>
            <button type="submit" className={ui.primary} disabled={busy}>Save and use</button>
            <button type="button" className={ui.secondary} disabled={busy} onClick={(e) => void submitProvider(e as unknown as FormEvent, false)}>Save</button>
            <button type="button" className={ui.textLink} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>}
      </Card>

      <Card title="Models" action={Object.keys(models).length ? <button type="button" className={ui.primary} disabled={busy} onClick={saveModels}>Save models</button> : undefined}>
        <p className={styles.note}>Model names as your provider spells them (for example <code>claude-sonnet-5-5</code> or <code>deepseek-v4.1-flash</code>), or <code>latest:</code> and a family (<code>latest:haiku</code>, <code>latest:sonnet</code>, <code>latest:deepseek-flash</code>, <code>latest:kimi-code</code>) to follow the newest model your provider lists, checked hourly. A tier&apos;s model wins for every task in that tier.</p>
        <table className={styles.tiers}>
          <thead><tr><th scope="col">Tier</th><th scope="col">Model</th><th scope="col">Effort</th></tr></thead>
          <tbody>{TIERS.map(([k, name, use]) => <tr key={k}>
            <th scope="row">{name}<small>{use}</small></th>
            <td><input aria-label={`${name} model`} value={modelValue(`RESEARCH_${k}_MODEL`)} placeholder={hint(`RESEARCH_${k}_MODEL`)} onChange={(e) => setModel(`RESEARCH_${k}_MODEL`, e.target.value)} />{resolved(`RESEARCH_${k}_MODEL`)}</td>
            <td><select aria-label={`${name} effort`} value={modelValue(`RESEARCH_${k}_EFFORT`)} onChange={(e) => setModel(`RESEARCH_${k}_EFFORT`, e.target.value)}>
              <option value="">{view.env[`RESEARCH_${k}_EFFORT`] ? `From env: ${view.env[`RESEARCH_${k}_EFFORT`]}` : "Default"}</option>
              {view.efforts.map((x) => <option key={x} value={x}>{x}</option>)}</select></td>
          </tr>)}</tbody>
        </table>
        <label className={styles.field}><span>Every other task <Tag tone="neutral">beats per-agent models</Tag></span>
          <input value={modelValue("RESEARCH_ALL_AGENTS_MODEL")} placeholder={hint("RESEARCH_ALL_AGENTS_MODEL")} onChange={(e) => setModel("RESEARCH_ALL_AGENTS_MODEL", e.target.value)} />
          <small>For tasks whose tier has no model set.</small>{resolved("RESEARCH_ALL_AGENTS_MODEL")}</label>
        <details className={styles.agents}>
          <summary>Per agent ({view.agents.length})</summary>
          <p className={styles.note}>Used only when neither the task&apos;s tier nor “Every other task” has a model.</p>
          <div className={styles.agentGrid}>{view.agents.map((a) => {
            const key = `RESEARCH_${agentKey(a)}_MODEL`;
            return <label key={a} className={styles.field}><span>{words(a)}</span>
              <input value={modelValue(key)} placeholder={hint(key)} onChange={(e) => setModel(key, e.target.value)} />{resolved(key)}</label>;
          })}</div>
        </details>
      </Card>
    </div>
  </div>;
}
