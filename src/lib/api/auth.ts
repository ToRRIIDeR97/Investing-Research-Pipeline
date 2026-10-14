// Single-operator API token (#8). Imported by the request proxy (src/proxy.ts).
export const SESSION_COOKIE = "research_os_session";

export function apiToken(): string {
  return (process.env.RESEARCH_OS_API_TOKEN || "").trim();
}

// Compares without stopping at the first differing character, so timing doesn't reveal a prefix.
export function tokenMatches(candidate: string | null | undefined, token: string): boolean {
  if (!token || !candidate || candidate.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= candidate.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

// Host names added in RESEARCH_APP_ALLOWED_HOSTS, lower-cased: a configured deployment.
export function configuredHosts(): string[] {
  return (process.env.RESEARCH_APP_ALLOWED_HOSTS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}

// The page to return to after sign-in: only a same-origin path ("/x", never "//x", "/\x" or a URL).
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return null;
  try {
    return new URL(value, "http://n.invalid").origin === "http://n.invalid" ? value : null;
  } catch {
    return null;
  }
}

// Where /login sends the browser after sign-in. A client-side navigation reaches /login through a
// redirect in which Next decodes the `next` value, so its own query params arrive beside it; they
// are put back (without Next's `_rsc` key) before the result is checked.
export function loginReturnPath(search: string): string {
  const params = new URLSearchParams(search);
  const next = params.get("next");
  params.delete("next");
  params.delete("_rsc");
  const rest = params.toString();
  return safeNextPath(next && rest ? `${next}${next.includes("?") ? "&" : "?"}${rest}` : next) || "/";
}
