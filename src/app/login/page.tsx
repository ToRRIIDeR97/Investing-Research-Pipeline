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

  return <div className={ui.page}><section className={`${ui.tile} mx-auto mt-16 max-w-[400px]`}>
    <div className="flex items-center gap-2.5 px-3.5 pt-5"><PragmaMark size={28} /><span className="font-[family-name:var(--font-display)] text-[20px] text-[var(--navy)]">Pragma Research</span></div>
    <form onSubmit={submit} className={`${ui.form} ${ui.tileBody}`}>
      <h1 className="text-[15px] font-semibold">Sign in</h1>
      <p className={ui.muted}>Enter the operator token set in RESEARCH_OS_API_TOKEN.</p>
      <label className={ui.field}>Token<input required type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} /></label>
      {error && <p role="alert" className={ui.error}>{error}</p>}
      <div><button className={ui.primary} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button></div>
    </form>
  </section></div>;
}
