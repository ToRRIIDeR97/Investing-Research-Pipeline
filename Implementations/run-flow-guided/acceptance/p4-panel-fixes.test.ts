// Added after the review panel (round 1). The frozen tests are unchanged; these check AC-9 and AC-10 more strictly.
import { read } from "./support";
import { test } from "node:test";
import assert from "node:assert/strict";

const run = () => read("src/app/assets/[id]/run/page.tsx");

/** The body of `async function name(...) { ... }`, by brace matching. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

/** Every `useEffect(...)` call's full text, by parenthesis matching. */
function effects(src: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf("useEffect("); at >= 0; at = src.indexOf("useEffect(", at + 1)) {
    let depth = 0;
    for (let i = at + "useEffect".length; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) { out.push(src.slice(at, i + 1)); break; }
    }
  }
  return out;
}

const GATED: Record<string, string> = {
  handleApprovePlan: "approve-plan", handleRequestPlanChanges: "request-plan-changes",
  handleRequestReset: "request-reset", handleCancelRun: "cancel", createAndStartRun: "run-system-pipeline",
};

test("AC-10: each gate, cancel and start call lives in its handler and nowhere else", () => {
  const src = run();
  for (const [name, path] of Object.entries(GATED)) {
    assert.match(fnBody(src, name), new RegExp(`/${path}\``), `${name} calls ${path}`);
    const elsewhere = src.split(fnBody(src, name)).join("");
    assert.doesNotMatch(elsewhere, new RegExp(`research-runs/\\$\\{[^}]+\\}/${path}\``), `${path} is fetched only inside ${name}`);
  }
});

test("AC-10: no effect calls a gate, cancel or start handler", () => {
  const names = [...Object.keys(GATED), "handleSend"];
  const list = effects(run());
  assert.ok(list.length >= 2);
  for (const effect of list) for (const name of names) assert.ok(!effect.includes(name), `an effect mentions ${name}`);
});

test("AC-10: the handlers are reached only from clicks, the start form's submit, or each other", () => {
  const src = run();
  const uses = (name: string) => [...src.matchAll(new RegExp(`\\b${name}\\b`, "g"))].map((m) => src.slice(Math.max(0, m.index! - 80), m.index! + name.length + 5));
  for (const name of ["handleApprovePlan", "handleRequestPlanChanges", "handleRequestReset", "handleCancelRun"]) {
    for (const ctx of uses(name).filter((c) => !c.includes(`async function ${name}`))) assert.match(ctx, /onClick=\{/, `${name} used outside a click: ${ctx}`);
  }
  for (const ctx of uses("handleSend").filter((c) => !c.includes("async function handleSend"))) assert.match(ctx, /onSubmit=\{/);
  for (const ctx of uses("createAndStartRun").filter((c) => !c.includes("async function createAndStartRun"))) assert.match(ctx, /if \(phase === "intake"\) await createAndStartRun/);
});

test("AC-9: the Details fold ignores toggles from the folds nested inside it", () => {
  assert.match(run(), /<details className=\{styles\.details\}[^>]*onToggle=\{\(event\) => \{ if \(event\.target === event\.currentTarget\) setDetailsOpen\(event\.currentTarget\.open\)/);
});

test("AC-9: the company search filters by name or ticker", () => {
  const src = read("src/app/research/new/page.tsx");
  assert.match(src, /assets\.filter\(\(a\) => a\.canonical_name\.toLowerCase\(\)\.includes\(q\) \|\| a\.slug\.toLowerCase\(\)\.includes\(q\)\)/);
  assert.match(src, /\{shown\.map\(/);
});
