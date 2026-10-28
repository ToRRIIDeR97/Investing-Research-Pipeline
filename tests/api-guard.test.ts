import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "../src/proxy";
import { loginReturnPath, safeNextPath } from "../src/lib/api/auth";
import nextConfig from "../next.config";

const request = (path: string, method: string, headers: Record<string, string>) =>
  new NextRequest(`http://localhost:3000${path}`, { method, headers });
const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

test("the API answers only local Host names, so a rebound DNS name can't read it (S1, #8)", () => {
  for (const host of ["localhost:3000", "127.0.0.1:3002", "[::1]:3000", "LOCALHOST:3000"]) {
    assert.ok(passes(proxy(request("/api/assets", "GET", { host }))), host);
  }
  for (const host of ["evil.example:3000", "localhost.evil.example", "192.168.1.20:3000", ""]) {
    assert.equal(proxy(request("/api/assets", "GET", { host })).status, 403, host);
  }
  const saved = process.env.RESEARCH_APP_ALLOWED_HOSTS;
  process.env.RESEARCH_APP_ALLOWED_HOSTS = "research.lan, Workstation.local";
  try {
    assert.ok(passes(proxy(request("/api/assets", "GET", { host: "research.lan:3000" }))));
    assert.ok(passes(proxy(request("/api/assets", "GET", { host: "workstation.local" }))));
  } finally {
    if (saved === undefined) delete process.env.RESEARCH_APP_ALLOWED_HOSTS;
    else process.env.RESEARCH_APP_ALLOWED_HOSTS = saved;
  }
});

test("the proxy covers dotted page paths and skips only Next's assets and static files", () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
  for (const url of ["/", "/assets/BRK.B", "/assets/BRK.B/research", "/review", "/login", "/api/assets", "/api/report.json"]) {
    assert.ok(matches(url), url);
  }
  for (const url of ["/_next/static/chunks/app.js", "/_next/image", "/favicon.ico", "/report-layouts/index.html",
    "/report-layouts/styles.css", "/report-layouts/presentation.mjs", "/report-layouts/report-data.json", "/logo.svg", "/font.woff2"]) {
    assert.ok(!matches(url), url);
  }
  assert.equal(proxy(request("/assets/BRK.B", "GET", { host: "evil.example" })).status, 403);
});

test("state-changing API calls must come from the app's own origin (S1, #8)", () => {
  const host = "localhost:3000";
  // The UI's own calls: run creation, plan approval, chat, uploads, and polling the worker health.
  for (const path of ["/api/research-runs/1/run-system-pipeline", "/api/research-runs/1/approve-plan", "/api/research-runs/1/chat",
    "/api/research-runs/1/sources/ingest", "/api/assets"]) {
    assert.ok(passes(proxy(request(path, "POST", { host, origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))), path);
    assert.ok(passes(proxy(request(path, "POST", { host, origin: "http://localhost:3000" }))), `${path} origin only`);
    assert.ok(passes(proxy(request(path, "POST", { host, "sec-fetch-site": "same-origin" }))), `${path} fetch metadata only`);
  }
  assert.ok(passes(proxy(request("/api/research-workers/health", "GET", { host, "sec-fetch-site": "cross-site" }))));
  assert.ok(passes(proxy(request("/api/saved-charts/1", "PATCH", { host, "sec-fetch-site": "none" }))));

  // A no-cors text/plain POST or a form post from another site, and curl without the header.
  for (const headers of <Record<string, string>[]>[
    { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" },
    { origin: "http://localhost:3001", "sec-fetch-site": "same-site" },
    { origin: "null" },
    { origin: "https://localhost:3000" },
    {},
  ]) {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.equal(proxy(request("/api/research-runs/1/approve-plan", method, { host, ...headers })).status, 403, `${method} ${JSON.stringify(headers)}`);
    }
  }
});

test("chat accepts the app's own origin when it is served from 127.0.0.1 (#8)", async () => {
  // npm run dev now prints http://127.0.0.1:3000, and NextURL rewrites loopback hosts to localhost,
  // so the chat route's own Origin check, which compared with nextUrl.origin, refused the UI.
  const { POST } = await import("../src/app/api/research-runs/[id]/chat/route");
  const runId = crypto.randomUUID();
  const params = { params: Promise.resolve({ id: runId }) };
  const chatFrom = (origin: string) => new NextRequest(`http://127.0.0.1:3000/api/research-runs/${runId}/chat`, {
    method: "POST", body: JSON.stringify({ message: "hi" }),
    headers: { host: "127.0.0.1:3000", origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
  });
  const chat = chatFrom("http://127.0.0.1:3000");
  assert.ok(passes(proxy(chat)));
  assert.equal((await POST(chatFrom("https://unrelated.example"), params)).status, 403);
  const saved = { RUN_PAID_RESEARCH: process.env.RUN_PAID_RESEARCH, RESEARCH_MODEL_PROVIDER: process.env.RESEARCH_MODEL_PROVIDER };
  delete process.env.RUN_PAID_RESEARCH;
  delete process.env.RESEARCH_MODEL_PROVIDER;
  try {
    // With no provider enabled the route answers 503 before it touches the database.
    assert.equal((await POST(chat, params)).status, 503);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("cancel accepts the app's own origin when it is served from 127.0.0.1 (#123)", async () => {
  const { POST } = await import("../src/app/api/research-runs/[id]/cancel/route");
  const runId = crypto.randomUUID();
  const params = { params: Promise.resolve({ id: runId }) };
  const cancelFrom = (origin: string) => new NextRequest(`http://127.0.0.1:3000/api/research-runs/${runId}/cancel`, {
    method: "POST", body: "{}", headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json" },
  });
  assert.equal((await POST(cancelFrom("https://unrelated.example"), params)).status, 403);
  assert.equal((await POST(cancelFrom("http://localhost:3000"), params)).status, 403);
  // Past the origin check the route opens the database; a closed port makes that fail with 500, not 403.
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/none";
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal((await POST(cancelFrom("http://127.0.0.1:3000"), params)).status, 500);
  } finally {
    console.error = error;
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test("no page can be framed (S1)", async () => {
  const rules = await nextConfig.headers!();
  const headers = Object.fromEntries(rules.find((rule) => rule.source === "/:path*")!.headers.map((header) => [header.key, header.value]));
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Content-Security-Policy"], "frame-ancestors 'none'");
});

test("the dev and start servers bind to loopback (#8)", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  assert.match(scripts.dev, /-H 127\.0\.0\.1/);
  assert.match(scripts.start, /-H 127\.0\.0\.1/);
});

const TOKEN = "test-operator-token-0123456789";
async function withToken<T>(token: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.RESEARCH_OS_API_TOKEN;
  if (token === undefined) delete process.env.RESEARCH_OS_API_TOKEN;
  else process.env.RESEARCH_OS_API_TOKEN = token;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.RESEARCH_OS_API_TOKEN;
    else process.env.RESEARCH_OS_API_TOKEN = saved;
  }
}

test("without RESEARCH_OS_API_TOKEN the API and pages stay open on loopback (#8)", async () => {
  await withToken(undefined, () => {
    assert.ok(passes(proxy(request("/api/assets", "GET", { host: "localhost:3000" }))));
    assert.ok(passes(proxy(request("/review", "GET", { host: "localhost:3000" }))));
  });
});

test("with RESEARCH_OS_API_TOKEN the API needs the bearer token or the session cookie (#8)", async () => {
  const host = "127.0.0.1:3000";
  await withToken(TOKEN, () => {
    assert.equal(proxy(request("/api/assets", "GET", { host })).status, 401);
    assert.equal(proxy(request("/api/assets", "GET", { host, authorization: "Bearer wrong" })).status, 401);
    assert.equal(proxy(request("/api/assets", "GET", { host, cookie: "research_os_session=wrong" })).status, 401);
    assert.ok(passes(proxy(request("/api/assets", "GET", { host, authorization: `Bearer ${TOKEN}` }))));
    assert.ok(passes(proxy(request("/api/assets", "GET", { host, cookie: `research_os_session=${TOKEN}` }))));
    // The token doesn't replace the same-origin check on writes.
    assert.equal(proxy(request("/api/research-runs/1/approve-plan", "POST", { host, authorization: `Bearer ${TOKEN}` })).status, 403);
    assert.ok(passes(proxy(request("/api/research-runs/1/approve-plan", "POST", { host, authorization: `Bearer ${TOKEN}`, "sec-fetch-site": "same-origin" }))));
    // Signing in needs no token, but still refuses foreign hosts and cross-site posts.
    assert.ok(passes(proxy(request("/api/session", "POST", { host, "sec-fetch-site": "same-origin" }))));
    assert.equal(proxy(request("/api/session", "POST", { host, origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal(proxy(request("/api/session", "POST", { host: "evil.example", "sec-fetch-site": "same-origin" })).status, 403);
    // Pages without the cookie render /login at the requested address (no redirect to another host).
    const page = proxy(request("/review?run=1", "GET", { host }));
    assert.equal(page.headers.get("location"), null);
    const rewrite = new URL(page.headers.get("x-middleware-rewrite")!);
    assert.equal(rewrite.pathname, "/login");
    assert.equal(rewrite.searchParams.get("next"), "/review?run=1");
    // A dotted page path gets the token check too; a client-side navigation's _rsc key isn't kept.
    const dotted = new URL(proxy(request("/assets/BRK.B?_rsc=abc", "GET", { host })).headers.get("x-middleware-rewrite")!);
    assert.equal(dotted.pathname, "/login");
    assert.equal(dotted.searchParams.get("next"), "/assets/BRK.B");
    assert.ok(passes(proxy(request("/login", "GET", { host }))));
    assert.ok(passes(proxy(request("/review", "GET", { host, cookie: `research_os_session=${TOKEN}` }))));
  });
});

test("after sign-in the login page returns only to a same-origin path (#8)", () => {
  for (const path of ["/", "/assets/BRK.B", "/review?run=1&tab=a", "/runs/1#plan"]) assert.equal(safeNextPath(path), path);
  for (const path of ["//evil.com", "https://evil.com", "/\\evil.com", "/\\/evil.com", "\\evil.com", "evil.com", "/\tevil", "", null]) {
    assert.equal(safeNextPath(path), null, String(path));
  }
  // The proxy's encoded rewrite, and the decoded form Next's client-side redirect delivers.
  assert.equal(loginReturnPath("?next=%2Freview%3Frun%3D1%26tab%3Da"), "/review?run=1&tab=a");
  assert.equal(loginReturnPath("?next=/review?run=1&tab=a&_rsc"), "/review?run=1&tab=a");
  assert.equal(loginReturnPath("?next=/assets/BRK.B&_rsc"), "/assets/BRK.B");
  for (const search of ["", "?next=//evil.com", "?next=https://evil.com", "?next=/%5Cevil.com", "?next=//evil.com&x=1"]) {
    assert.equal(loginReturnPath(search), "/", search);
  }
});

test("POST /api/session sets an HttpOnly cookie only for the right token (#8)", async () => {
  const { POST, DELETE } = await import("../src/app/api/session/route");
  const signIn = (token: string) => POST(new NextRequest("http://127.0.0.1:3000/api/session", {
    method: "POST", body: JSON.stringify({ token }), headers: { "content-type": "application/json" },
  }));
  await withToken(TOKEN, async () => {
    const refused = await signIn("wrong");
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("set-cookie"), null);
    const accepted = await signIn(TOKEN);
    assert.equal(accepted.status, 200);
    const cookie = accepted.headers.get("set-cookie") || "";
    assert.match(cookie, new RegExp(`^research_os_session=${TOKEN};`));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=strict/i);
    assert.doesNotMatch(cookie, /Secure/i);
    assert.match((await DELETE()).headers.get("set-cookie") || "", /Max-Age=0/);
  });
});

test("the session cookie is Secure behind a TLS proxy only for a configured host (#8)", async () => {
  const { POST } = await import("../src/app/api/session/route");
  // `next start` builds nextUrl from X-Forwarded-Proto, so a loopback request with it arrives as https.
  const signIn = (host: string, proto: string) => POST(new NextRequest(`${proto}://${host}/api/session`, {
    method: "POST", body: JSON.stringify({ token: TOKEN }),
    headers: { "content-type": "application/json", host, "x-forwarded-proto": proto },
  }));
  const saved = process.env.RESEARCH_APP_ALLOWED_HOSTS;
  process.env.RESEARCH_APP_ALLOWED_HOSTS = "research.example";
  try {
    await withToken(TOKEN, async () => {
      assert.match((await signIn("research.example", "https")).headers.get("set-cookie") || "", /Secure/i);
      assert.doesNotMatch((await signIn("research.example", "http")).headers.get("set-cookie") || "", /Secure/i);
      assert.doesNotMatch((await signIn("127.0.0.1:3000", "https")).headers.get("set-cookie") || "", /Secure/i);
    });
  } finally {
    if (saved === undefined) delete process.env.RESEARCH_APP_ALLOWED_HOSTS;
    else process.env.RESEARCH_APP_ALLOWED_HOSTS = saved;
  }
});
