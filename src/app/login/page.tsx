"use client";

import { useState, type FormEvent } from "react";
import ui from "@/components/research-ui.module.css";
import { PragmaMark } from "@/components/brand/logo";
import { loginReturnPath } from "@/lib/api/auth";

// The request proxy renders this page in place of any page requested without the session cookie,
// so after signing in it reloads the address the browser asked for. At /login itself (opened
// directly, or after a client-side navigation) it goes to a safe `next` path, else home.
export default function LoginPage() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      if (!response.ok) throw new Error();
      if (window.location.pathname === "/login") window.location.assign(loginReturnPath(window.location.search));
      else window.location.reload();
    } catch {
      setError("That token wasn't accepted.");
      setBusy(false);
    }
  }

  return <div className={ui.page}><section className={`${ui.tile} mx-auto mt-20 max-w-[420px] overflow-hidden`}>
    <div className="flex items-center gap-3 border-b border-[var(--line-soft)] bg-[var(--navy-soft)] px-[18px] py-5"><PragmaMark size={32} /><div><div className="text-[18px] font-bold tracking-[-0.01em] text-[var(--ink)]">Pragma Research</div><div className="text-[12px] text-[var(--ink-2)]">Evidence-backed research with human review gates</div></div></div>
    <form onSubmit={submit} className={`${ui.form} ${ui.tileBody}`}>
      <h1 className="text-[18px] font-bold tracking-[-0.01em]">Sign in</h1>
      <p className={ui.muted}>Enter the operator token set in RESEARCH_OS_API_TOKEN.</p>
      <label className={ui.field}>Token<input required type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} /></label>
      {error && <p role="alert" className={ui.error}>{error}</p>}
      <div><button className={ui.primary} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button></div>
    </form>
  </section></div>;
}
