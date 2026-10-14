import { NextResponse, type NextRequest } from "next/server";

// The API has no accounts (#8), so it refuses what another site could make the user's browser
// send: a request for a foreign Host name (DNS rebinding) and, for methods that change state,
// a request from another origin (CSRF). Non-browser clients send neither header and must add
// `Sec-Fetch-Site: same-origin` to POST, PATCH or DELETE.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostAllowed(host: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  const extra = (process.env.RESEARCH_APP_ALLOWED_HOSTS || "").split(",").map((value) => value.trim().toLowerCase());
  return [...LOCAL_HOSTS, ...extra].filter(Boolean).includes(hostname);
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") || "";
  if (!hostAllowed(host)) return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
  if (SAFE_METHODS.has(request.method)) return NextResponse.next();
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (site === "same-origin" || site === "none" || origin === `${request.nextUrl.protocol}//${host}`) return NextResponse.next();
  return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
}

export const config = { matcher: "/api/:path*" };
