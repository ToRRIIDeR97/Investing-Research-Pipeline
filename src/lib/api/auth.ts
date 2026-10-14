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
