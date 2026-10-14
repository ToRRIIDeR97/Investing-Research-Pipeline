import { NextRequest, NextResponse } from "next/server";
import { apiToken, configuredHosts, SESSION_COOKIE, tokenMatches } from "@/lib/api/auth";

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// Secure over HTTPS, or behind a TLS proxy that sends `X-Forwarded-Proto: https`. The header is
// trusted only for a Host listed in RESEARCH_APP_ALLOWED_HOSTS, since a local client can send it.
// `next start` also derives nextUrl.protocol from that header, so when it is present it decides.
function servedOverHttps(request: NextRequest): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (!forwarded) return request.nextUrl.protocol === "https:";
  if (forwarded.split(",")[0].trim().toLowerCase() !== "https") return false;
  let hostname = "";
  try {
    hostname = new URL(`http://${request.headers.get("host") || ""}`).hostname;
  } catch {
    return false;
  }
  return configuredHosts().includes(hostname);
}

// Exchanges RESEARCH_OS_API_TOKEN for an HttpOnly session cookie (#8). The request proxy lets this path
// through without a token but still applies its Host and same-origin checks.
export async function POST(request: NextRequest) {
  const token = apiToken();
  if (!token) return NextResponse.json({ authenticated: true, required: false });
  const body = await request.json().catch(() => null) as { token?: unknown } | null;
  const candidate = typeof body?.token === "string" ? body.token.trim() : "";
  if (!tokenMatches(candidate, token)) return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  const response = NextResponse.json({ authenticated: true, required: true });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "strict", path: "/", maxAge: MAX_AGE_SECONDS,
    secure: servedOverHttps(request),
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return response;
}
