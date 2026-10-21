import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decideRow, fileLines, importFiles, mirrorFiles, orderTables, parentFirst, rowHash, shardWriter, storeShards } from "@/lib/maintenance/research-store";

const store = '{"id":"a","v":2}';
const h = rowHash;

describe("research store three-way merge", () => {
  it("inserts a row this machine has never seen", () => {
    assert.equal(decideRow({ line: store }).decision, "insert");
  });
  it("keeps a local deletion when the store row is unchanged since the last export", () => {
    assert.equal(decideRow({ line: store, base: h(store) }).decision, "keep");
  });
  it("restores a row deleted here when the other machine changed it", () => {
    assert.equal(decideRow({ line: store, base: h('{"id":"a","v":1}') }).decision, "insert");
  });
  it("takes the store row when only the other machine changed it", () => {
    const old = '{"id":"a","v":1}';
    assert.equal(decideRow({ line: store, local: h(old), base: h(old) }).decision, "update");
  });
  it("keeps the local row when only this machine changed it", () => {
    assert.equal(decideRow({ line: store, local: h('{"id":"a","v":3}'), base: h(store) }).decision, "keep");
  });
  it("settles a two-sided change by updated_at, and keeps local without one", () => {
    const both = { line: store, local: h('{"id":"a","v":3}'), base: h('{"id":"a","v":1}') };
    assert.deepEqual(decideRow({ ...both, storeUpdatedAt: "2026-10-02T00:00:00Z", localUpdatedAt: "2026-10-01T00:00:00Z" }), { decision: "update", conflict: "store" });
    assert.deepEqual(decideRow({ ...both, storeUpdatedAt: "2026-10-01T00:00:00Z", localUpdatedAt: "2026-10-02T00:00:00Z" }), { decision: "keep", conflict: "local" });
    assert.deepEqual(decideRow(both), { decision: "keep", conflict: "local" });
  });
});

describe("research store table order", () => {
  it("puts parents before children and ignores self-references", () => {
    const order = orderTables(["runs", "stages", "assets", "artifacts"], [
      { from: "runs", to: "assets" }, { from: "stages", to: "runs" }, { from: "artifacts", to: "runs" }, { from: "artifacts", to: "artifacts" },
    ]);
    assert.ok(order.indexOf("assets") < order.indexOf("runs"));
    assert.ok(order.indexOf("runs") < order.indexOf("stages"));
    assert.ok(order.indexOf("runs") < order.indexOf("artifacts"));
  });
  it("rejects a foreign-key cycle", () => {
    assert.throws(() => orderTables(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }]), /cycle/);
  });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "research-store-"));
  const put = (path: string, body = path) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
  const link = (path: string, target: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); symlinkSync(target, join(root, path)); };
  return { root, put, link, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("research store self-references", () => {
  const add = (order: ReturnType<typeof parentFirst>, id: string, parent: string | null) => order.add({ id, parent }, id);

  it("holds a row until the row it points at has gone in", () => {
    const order = parentFirst(["parent"], id => id === "local");
    assert.deepEqual(add(order, "a", null), ["a"]);
    assert.deepEqual(add(order, "b", "local"), ["b"]);
    assert.deepEqual(add(order, "c", "a"), ["c"]);
    assert.deepEqual(add(order, "d", "e"), []);
    assert.deepEqual(add(order, "f", "d"), []);
    assert.deepEqual(add(order, "e", null), ["e"]);
    assert.deepEqual(order.rest(), { ordered: ["d", "f"], leftover: [] });
  });

  it("leaves cycles and missing parents for the last statement", () => {
    const order = parentFirst(["parent"], () => false);
    add(order, "x", "y");
    add(order, "y", "x");
    add(order, "z", "missing");
    assert.deepEqual(order.rest(), { ordered: [], leftover: ["x", "y", "z"] });
  });
});

describe("research store files", () => {
  it("skips links that leave storage/ on export, in a referenced folder or named directly", async () => {
    const t = scratch();
    try {
      t.put("project/.env.local", "SECRET=1");
      t.put("project/storage/backtests/run1/trades.csv");
      t.link("project/storage/backtests/run1/equity.csv", join(t.root, "project/.env.local"));
      t.put("project/storage/sources/a.txt");
      t.link("project/storage/sources/leak.txt", join(t.root, "project/.env.local"));
      const r = await mirrorFiles(["storage/backtests/run1", "storage/sources/a.txt", "storage/sources/leak.txt"],
        { storeDir: join(t.root, "store"), projectRoot: join(t.root, "project") });
      assert.equal(r.files, 2);
      assert.ok(existsSync(join(t.root, "store/files/storage/backtests/run1/trades.csv")));
      assert.ok(existsSync(join(t.root, "store/files/storage/sources/a.txt")));
      assert.ok(!existsSync(join(t.root, "store/files/storage/backtests/run1/equity.csv")));
      assert.ok(!existsSync(join(t.root, "store/files/storage/sources/leak.txt")));
      assert.deepEqual(r.skipped.map(s => s.path).sort(), ["storage/backtests/run1/equity.csv", "storage/sources/leak.txt"]);
    } finally { t.done(); }
  });

  it("still mirrors a worktree whose storage/<dir> links to the main checkout", async () => {
    const t = scratch();
    try {
      t.put("main/storage/backtests/run1/trades.csv");
      t.link("worktree/storage/backtests", join(t.root, "main/storage/backtests"));
      const r = await mirrorFiles(["storage/backtests/run1"], { storeDir: join(t.root, "store"), projectRoot: join(t.root, "worktree") });
      assert.equal(r.files, 1);
      assert.deepEqual(r.skipped, []);
      assert.ok(existsSync(join(t.root, "store/files/storage/backtests/run1/trades.csv")));
    } finally { t.done(); }
  });

  it("imports only regular files under storage/, and never through a link out of it", async () => {
    const t = scratch();
    try {
      t.put("store/files/storage/sources/x.txt");
      t.put("store/files/src/instrumentation.ts", "steal()");
      t.put("store/files/.env", "BACKTEST_SANDBOX=off");
      t.put("outside/secret.txt", "SECRET=1");
      t.link("store/files/storage/sources/link.txt", join(t.root, "outside/secret.txt"));
      t.put("store/files/storage/parses/sub/y.txt");
      mkdirSync(join(t.root, "project/storage/parses"), { recursive: true });
      t.link("project/storage/parses/sub", join(t.root, "outside"));
      const r = await importFiles({ storeDir: join(t.root, "store"), projectRoot: join(t.root, "project") });
      assert.equal(r.copied, 1);
      assert.ok(existsSync(join(t.root, "project/storage/sources/x.txt")));
      assert.ok(!existsSync(join(t.root, "project/src")));
      assert.ok(!existsSync(join(t.root, "project/.env")));
      assert.ok(!existsSync(join(t.root, "project/storage/sources/link.txt")));
      assert.ok(!existsSync(join(t.root, "outside/y.txt")));
      assert.deepEqual(r.skipped.map(s => s.path).sort(), [".env", "src/instrumentation.ts", "storage/parses/sub/y.txt", "storage/sources/link.txt"]);
    } finally { t.done(); }
  });
});

describe("research store table shards", () => {
  const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(6, "0")}-0000-0000-0000-000000000000`;

  it("writes one file per two-character id prefix", async () => {
    const t = scratch();
    try {
      const shards = shardWriter(join(t.root, "t"));
      for (const row of [id("0a", 1), id("0a", 2), id("0b", 1), id("ff", 1)].map(i => ({ id: i, line: `{"id":"${i}"}` }))) await shards.add(row);
      await shards.close();
      assert.deepEqual(readdirSync(join(t.root, "t")).sort(), ["0a.jsonl", "0b.jsonl", "ff.jsonl"]);
      assert.equal(readFileSync(join(t.root, "t/0a.jsonl"), "utf8").split("\n").filter(Boolean).length, 2);
    } finally { t.done(); }
  });

  it("refuses a shard over the size limit before writing it", async () => {
    const t = scratch();
    try {
      const shards = shardWriter(join(t.root, "t"), 100);
      await shards.add({ id: id("0a", 1), line: "x".repeat(40) });
      await shards.add({ id: id("0b", 1), line: "x".repeat(60) });
      await assert.rejects(shards.add({ id: id("0b", 2), line: "x".repeat(60) }), /Refusing to export: shard .*0b\.jsonl/);
      assert.equal(statSync(join(t.root, "t/0a.jsonl")).size, 41);
      assert.ok(!existsSync(join(t.root, "t/0b.jsonl")));
    } finally { t.done(); }
  });

  it("reads shard lines across read chunks, with CRLF and no final newline", async () => {
    const t = scratch();
    try {
      const long = "é".repeat(100_000);
      t.put("s.jsonl", `a\r\n\n${long}\nb\r\nc`);
      const lines: string[] = [];
      for await (const line of fileLines(join(t.root, "s.jsonl"))) lines.push(line);
      assert.deepEqual(lines, ["a", long, "b", "c"]);
    } finally { t.done(); }
  });

  it("reads one-character shards from older stores and skips linked shards", async () => {
    const t = scratch();
    try {
      t.put("store/tables/assets/0.jsonl");
      t.put("store/tables/assets/f.jsonl");
      t.put("store/tables/runs/0a.jsonl");
      t.put("outside/rows.jsonl");
      t.link("store/tables/runs/0b.jsonl", join(t.root, "outside/rows.jsonl"));
      const { shardFiles, skipped } = await storeShards(join(t.root, "store"));
      assert.deepEqual(shardFiles.get("assets")?.map(f => f.slice(-7)), ["0.jsonl", "f.jsonl"]);
      assert.deepEqual(shardFiles.get("runs")?.map(f => f.slice(-8)), ["0a.jsonl"]);
      assert.deepEqual(skipped.map(s => s.path), ["tables/runs/0b.jsonl"]);
    } finally { t.done(); }
  });
});
