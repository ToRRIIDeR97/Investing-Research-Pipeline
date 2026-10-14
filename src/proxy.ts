import { NextResponse, type NextRequest } from "next/server";
import { apiToken, configuredHosts, SESSION_COOKIE, tokenMatches } from "@/lib/api/auth";

// Every request first passes two browser guards: a foreign Host name is refused (DNS rebinding)
// and, for methods that change state, so is a request from another origin (CSRF). Non-browser
// clients send neither header and must add `Sec-Fetch-Site: same-origin` to POST, PATCH or DELETE.
//
// When RESEARCH_OS_API_TOKEN is set (#8), the API also needs that single-operator token, either as
// `Authorization: Bearer <token>` or in the HttpOnly session cookie that POST /api/session sets
// after the /login form. Pages without it render that form. Unset, the app stays open
// to anything that reaches the loopback port, as before.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SESSION_PATH = "/api/session";

function hostAllowed(host: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return [...LOCAL_HOSTS, ...configuredHosts()].includes(hostname);
}

function authenticated(request: NextRequest, token: string): boolean {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return tokenMatches(bearer, token) || tokenMatches(request.cookies.get(SESSION_COOKIE)?.value, token);
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") || "";
  if (!hostAllowed(host)) return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
  const { pathname } = request.nextUrl;
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  if (isApi && !SAFE_METHODS.has(request.method)) {
    const site = request.headers.get("sec-fetch-site");
    const origin = request.headers.get("origin");
    if (!(site === "same-origin" || site === "none" || origin === `${request.nextUrl.protocol}//${host}`)) {
      return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
    }
  }
  const token = apiToken();
  if (!token || pathname === SESSION_PATH || pathname === "/login" || authenticated(request, token)) return NextResponse.next();
  if (isApi) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  // Rendered in place rather than redirected: Next rewrites a 127.0.0.1 redirect to localhost, a
  // different cookie host. After signing in, the login page reloads the requested address, or goes
  // to `next` when the browser ended up at /login itself (a client-side navigation).
  const back = request.nextUrl.clone();
  back.searchParams.delete("_rsc");
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", back.pathname + back.search);
  return NextResponse.rewrite(login);
}

// The API and every page, including dotted ones such as /assets/BRK.B. Skipped: Next's own assets
// and static files by extension (favicon, images, fonts, and the public/report-layouts files).
export const config = {
  matcher: ["/api/:path*", "/((?!_next/|.*\\.(?:ico|png|jpe?g|gif|svg|webp|css|m?js|map|json|html|txt|xml|woff2?|ttf)$).*)"],
};
