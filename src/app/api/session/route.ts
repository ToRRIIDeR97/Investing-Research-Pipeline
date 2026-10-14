import { NextRequest, NextResponse } from "next/server";
import { apiToken, SESSION_COOKIE, tokenMatches } from "@/lib/api/auth";

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

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
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return response;
}
