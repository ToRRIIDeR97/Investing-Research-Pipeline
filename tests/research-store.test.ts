import { describe, it } from "node:test";
import assert from "node:assert";
import { decideRow, orderTables, rowHash } from "@/lib/maintenance/research-store";

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
