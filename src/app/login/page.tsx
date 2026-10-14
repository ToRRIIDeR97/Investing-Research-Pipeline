"use client";

import { useState, type FormEvent } from "react";
import ui from "@/components/research-ui.module.css";

// The request proxy renders this page in place of any page requested without the session cookie,
// so after signing in it reloads the address the browser asked for (or goes home from /login).
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
      if (window.location.pathname === "/login") window.location.assign("/");
      else window.location.reload();
    } catch {
      setError("That token wasn't accepted.");
      setBusy(false);
    }
  }

  return <div className={ui.page}><section className={ui.section}><h1>Sign in</h1><p className={ui.muted}>Enter the operator token set in RESEARCH_OS_API_TOKEN.</p><form onSubmit={submit} className="research-form"><label>Token<input required type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} /></label><button className={ui.primary} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button></form></section>{error && <p role="alert" className={ui.error}>{error}</p>}</div>;
}
