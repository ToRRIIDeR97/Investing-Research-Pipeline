import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { config, middleware } from "../src/middleware";
import nextConfig from "../next.config";

const request = (path: string, method: string, headers: Record<string, string>) =>
  new NextRequest(`http://localhost:3000${path}`, { method, headers });
const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

test("the API answers only local Host names, so a rebound DNS name can't read it (S1, #8)", () => {
  assert.equal(config.matcher, "/api/:path*");
  for (const host of ["localhost:3000", "127.0.0.1:3002", "[::1]:3000", "LOCALHOST:3000"]) {
    assert.ok(passes(middleware(request("/api/assets", "GET", { host }))), host);
  }
  for (const host of ["evil.example:3000", "localhost.evil.example", "192.168.1.20:3000", ""]) {
    assert.equal(middleware(request("/api/assets", "GET", { host })).status, 403, host);
  }
  const saved = process.env.RESEARCH_APP_ALLOWED_HOSTS;
  process.env.RESEARCH_APP_ALLOWED_HOSTS = "research.lan, Workstation.local";
  try {
    assert.ok(passes(middleware(request("/api/assets", "GET", { host: "research.lan:3000" }))));
    assert.ok(passes(middleware(request("/api/assets", "GET", { host: "workstation.local" }))));
  } finally {
    if (saved === undefined) delete process.env.RESEARCH_APP_ALLOWED_HOSTS;
    else process.env.RESEARCH_APP_ALLOWED_HOSTS = saved;
  }
});

test("state-changing API calls must come from the app's own origin (S1, #8)", () => {
  const host = "localhost:3000";
  // The UI's own calls: run creation, plan approval, chat, uploads, and polling the worker health.
  for (const path of ["/api/research-runs/1/run-system-pipeline", "/api/research-runs/1/approve-plan", "/api/research-runs/1/chat",
    "/api/research-runs/1/sources/ingest", "/api/assets"]) {
    assert.ok(passes(middleware(request(path, "POST", { host, origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))), path);
    assert.ok(passes(middleware(request(path, "POST", { host, origin: "http://localhost:3000" }))), `${path} origin only`);
    assert.ok(passes(middleware(request(path, "POST", { host, "sec-fetch-site": "same-origin" }))), `${path} fetch metadata only`);
  }
  assert.ok(passes(middleware(request("/api/research-workers/health", "GET", { host, "sec-fetch-site": "cross-site" }))));
  assert.ok(passes(middleware(request("/api/saved-charts/1", "PATCH", { host, "sec-fetch-site": "none" }))));

  // A no-cors text/plain POST or a form post from another site, and curl without the header.
  for (const headers of <Record<string, string>[]>[
    { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" },
    { origin: "http://localhost:3001", "sec-fetch-site": "same-site" },
    { origin: "null" },
    { origin: "https://localhost:3000" },
    {},
  ]) {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.equal(middleware(request("/api/research-runs/1/approve-plan", method, { host, ...headers })).status, 403, `${method} ${JSON.stringify(headers)}`);
    }
  }
});

test("chat accepts the app's own origin when it is served from 127.0.0.1 (#8)", async () => {
  // npm run dev now prints http://127.0.0.1:3000, and NextURL rewrites loopback hosts to localhost,
  // so the chat route's own Origin check used to refuse the UI. The middleware does that check now.
  const { POST } = await import("../src/app/api/research-runs/[id]/chat/route");
  const runId = crypto.randomUUID();
  const headers = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const chat = new NextRequest(`http://127.0.0.1:3000/api/research-runs/${runId}/chat`, { method: "POST", headers, body: JSON.stringify({ message: "hi" }) });
  assert.ok(passes(middleware(chat)));
  const saved = { RUN_PAID_RESEARCH: process.env.RUN_PAID_RESEARCH, RESEARCH_MODEL_PROVIDER: process.env.RESEARCH_MODEL_PROVIDER };
  delete process.env.RUN_PAID_RESEARCH;
  delete process.env.RESEARCH_MODEL_PROVIDER;
  try {
    // With no provider enabled the route answers 503 before it touches the database.
    assert.equal((await POST(chat, { params: Promise.resolve({ id: runId }) })).status, 503);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
