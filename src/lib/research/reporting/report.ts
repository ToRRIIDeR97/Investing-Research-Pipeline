import { resolveTable } from "./tables";
import { validateVisual, historySeries, buildVisual } from './visuals';
export { resolveTable } from "./tables";
import { createHash } from "node:crypto";
import { Section, CoverageResult, Question, STANDARD_VERSION, type ReportSection, type CoverageCheck, type ResearchQuestion } from "./contracts";

export interface ReportArtifact {
  id: string; artifact_type: string; scope_key: string; artifact_version: number;
  content_json: Record<string, any>;
}
export interface ReportEvidence {
  id: string; claim_text: string; source_title: string; url: string;
  published_at: string; location: string; quote: string;
}
export interface ReportInput {
  asset_name: string; cutoff: string; is_test: boolean; required_coverage: string[];
  sections: ReportSection[]; coverage: CoverageCheck[]; questions: ResearchQuestion[];
  evidence: ReportEvidence[]; artifacts: ReportArtifact[];
}
export interface ReportDocument extends ReportInput {
  standard_version: string; input_hash: string; content_hash: string;
  conclusion_status: "ready_for_review" | "qualified" | "withheld"; markdown: string;
}

/** The review packet supplies the corpus once, alongside this lossless report body. */
export function reviewDocument(document: ReportDocument) {
  const { markdown, artifacts, evidence, ...body } = document;
  return body;
}

export function fingerprint(value: unknown): string {
  function canonical(v: any): any {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
    return v;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function inputFingerprint(artifacts: ReportArtifact[], evidence: ReportEvidence[]): string {
  return fingerprint({ artifacts: [...artifacts].sort((a,b) => a.id.localeCompare(b.id)), evidence: [...evidence].sort((a,b) => a.id.localeCompare(b.id)) });
}

// Render plain model text; links and tables are generated from verified records.
export function plainMarkdown(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]#|])/g, "\\$1").replace(/\r?\n/g, " ");
}
function cell(value: unknown): string { return plainMarkdown(value == null ? "Not disclosed" : typeof value === "object" ? JSON.stringify(value) : String(value)); }
function tableMarkdown(value: unknown): string {
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length) return "No observations available.";
  if (rows.every(row => row && typeof row === "object" && !Array.isArray(row))) {
    const keys = [...new Set(rows.flatMap(row => Object.keys(row as object)))];
    return [`| ${keys.map(cell).join(" | ")} |`, `| ${keys.map(() => "---").join(" | ")} |`,
      ...rows.map((row: any) => `| ${keys.map(k => cell(row[k])).join(" | ")} |`)].join("\n");
  }
  return ["| Value |", "| --- |", ...rows.map(row => `| ${cell(row)} |`)].join("\n");
}

export function createReport(input: ReportInput): ReportDocument {
  const errors: string[] = [];
  const sections = input.sections.map(s => Section.parse(s));
  const coverage = input.coverage.map(c => CoverageResult.parse(c));
  const questions = input.questions.map(q => Question.parse(q));
  if (!sections.length) errors.push("Report needs at least one section");
  const sectionIds = new Set(sections.map(s => s.id));
  if (sectionIds.size !== sections.length) errors.push("Duplicate section IDs");
  if (new Set(coverage.map(c => c.key)).size !== coverage.length) errors.push("Duplicate coverage keys");
  if (new Set(questions.map(q => q.id)).size !== questions.length) errors.push("Duplicate question IDs");
  const artifacts = new Set(input.artifacts.map(a => a.id));
  const evidence = new Map(input.evidence.map(e => [e.id, e]));
  const cutoff = Date.parse(input.cutoff);
  if (!Number.isFinite(cutoff)) errors.push("Invalid source cutoff");
  function refs(eids: string[], aids: string[]) {
    for (const id of aids) if (!artifacts.has(id)) errors.push(`Unknown artifact ${id}`);
    for (const id of eids) {
      const e = evidence.get(id);
      if (!e) { errors.push(`Unknown evidence ${id}`); continue; }
      if (!e.quote.trim() || !e.location.trim()) errors.push(`Evidence ${id} has no source passage/location`);
      if (!/^https?:\/\//i.test(e.url)) errors.push(`Evidence ${id} has no usable source URL`);
      if (!Number.isFinite(Date.parse(e.published_at)) || Date.parse(e.published_at) > cutoff) errors.push(`Evidence ${id} is undated or beyond cutoff`);
    }
  }
  for (const section of sections) {
    for (const key of section.coverage) if (!input.required_coverage.includes(key)) errors.push(`Unknown section coverage ${key}`);
    refs([], section.artifact_ids);
    for (const p of section.paragraphs) {
      refs(p.evidence_ids, p.artifact_ids);
      if (p.kind === "fact" && !p.evidence_ids.length && !p.artifact_ids.length) errors.push(`Unsupported fact in ${section.id}`);
    }
    for (const table of section.tables) {
      try { resolveTable(table, input.artifacts); } catch (error) { errors.push(String(error)); }
    }
    for (const visual of section.visuals ?? []) {
      try { validateVisual(visual, input); } catch (error) { errors.push(String(error)); }
    }
  }
  for (const key of input.required_coverage) if (!coverage.some(c => c.key === key)) errors.push(`Missing coverage ${key}`);
  for (const check of coverage) {
    if (!input.required_coverage.includes(check.key)) errors.push(`Unknown coverage ${check.key}`);
    if (check.status !== "not_applicable" && !check.section_ids.length) errors.push(`Coverage ${check.key} needs a section`);
    for (const id of check.section_ids) {
      const section = sections.find(s => s.id === id);
      if (!section || !section.coverage.includes(check.key)) errors.push(`Coverage ${check.key} has no matching section ${id}`);
      else if (check.status === "satisfied" && !section.paragraphs.some(p => p.evidence_ids.length || p.artifact_ids.length)) errors.push(`Satisfied coverage ${check.key} lacks evidence`);
    }
  }
  for (const question of questions) {
    refs(question.evidence_ids, question.artifact_ids);
    if (question.status === "answered" && !question.evidence_ids.length && !question.artifact_ids.length) errors.push(`Question ${question.id} has no answer evidence`);
    if (question.status !== "answered" && !question.follow_up.trim()) errors.push(`Question ${question.id} needs follow-up`);
  }
  if (errors.length) throw new Error(errors.join("; "));
  const withheld = coverage.some(c => c.status === "blocked") || questions.some(q => q.status === "blocked" && q.materiality !== "supporting");
  const qualified = coverage.some(c => c.status === "qualified") || questions.some(q => q.status !== "answered");
  const usedIds = [...new Set([...sections.flatMap(s => s.paragraphs.flatMap(p => p.evidence_ids)), ...questions.flatMap(q => q.evidence_ids), ...sections.flatMap(s=>(s.visuals??[]).flatMap(v=>v.kind==='process'?v.lanes.flatMap(l=>l.evidence_ids):v.kind==='organization'?v.people.flatMap(p=>p.evidence_ids):[]))])];
  const citation = (id: string) => `[${usedIds.indexOf(id) + 1}]`;
  const lines = [`# ${plainMarkdown(input.asset_name)}: investment research`, "", `Research cutoff: ${input.cutoff}`, ""];
  if (input.is_test) lines.push("> TEST WATERMARK: Synthetic research. Not for investment decisions.", "");
  if (withheld) lines.push("> Conclusion withheld - research incomplete. Material questions remain unresolved.", "");
  else if (qualified) lines.push("> Qualified research: read the evidence limitations before relying on the conclusion.", "");
  for (const s of sections) {
    lines.push(`## ${plainMarkdown(s.title)}`, "");
    for (const p of s.paragraphs) lines.push(`${p.kind === "assumption" ? "Analyst assumption. " : p.kind === "speculation" ? "Speculative option. " : ""}${plainMarkdown(p.text)} ${p.evidence_ids.map(citation).join(" ")}`.trim(), "");
    for (const table of s.tables) lines.push(`### ${plainMarkdown(table.title)}`, "", tableMarkdown(resolveTable(table, input.artifacts)), "");
    // Visual specifications and provenance are part of the approved/exported content.
    for (const visual of s.visuals ?? []) {
      lines.push(`### ${plainMarkdown(visual.title)}`, '', plainMarkdown(visual.caption), '');
      if (visual.kind === 'process') for (const lane of visual.lanes) {
        lines.push(`${lane.nodes.map(n => plainMarkdown(n.label)).join(' → ')}. ${plainMarkdown(lane.note)} (${lane.relationship}) ${lane.evidence_ids.map(citation).join(' ')}`, '');
      } else if(visual.kind==='organization')lines.push(tableMarkdown(visual.people.map(p=>({Name:p.name,Role:p.role,'Reports to':visual.people.find(parent=>parent.id===p.reports_to)?.name??'Not disclosed',Sources:p.evidence_ids.map(citation).join(' ')}))),'');
      else if(visual.kind==='history')lines.push(tableMarkdown(historySeries(visual,input.artifacts).points.map(p=>({Period:p.period,Value:p.exact}))), '');
      else { // Charts export as their data table.
        const chart=buildVisual(visual,input.artifacts);
        lines.push(tableMarkdown(chart.points.map(p=>({[chart.category]:p.period,...Object.fromEntries(chart.columns.map((c,i)=>[c,p.exact[i]]))}))), '', ...chart.notes.map(plainMarkdown).flatMap(n=>[n,'']));
      }
    }
    lines.push(`Counterevidence and alternatives. ${plainMarkdown(s.counterevidence)}`, "", `Investment implication. ${plainMarkdown(s.implication)}`, "");
    if (s.gaps.length) lines.push("Evidence gaps:", "", ...s.gaps.map(g => `- ${plainMarkdown(g)}`), "");
  }
  lines.push("## Research completeness", "", "| Area | Outcome | Reason |", "| --- | --- | --- |",
    ...coverage.map(c => `| ${cell(c.key)} | ${cell(c.status)} | ${cell(c.rationale)} |`), "");
  if (questions.length) lines.push("## Research questions and follow-up", "", ...questions.flatMap(q => [
    `### ${plainMarkdown(q.question)}`, "", `${q.materiality} / ${q.status}. ${plainMarkdown(q.answer)} ${q.evidence_ids.map(citation).join(" ")}`,
    ...(q.follow_up ? ["", `Next evidence needed. ${plainMarkdown(q.follow_up)}`] : []), ""]));
  lines.push("## Sources", "");
  for (const id of usedIds) {
    const e = evidence.get(id)!;
    lines.push(`${citation(id)} [${plainMarkdown(e.source_title)}](${encodeURI(e.url).replace(/[()]/g, c => c === "(" ? "%28" : "%29")}) · ${plainMarkdown(e.published_at)} · ${plainMarkdown(e.location)}`, "", `Supporting passage: ${plainMarkdown(e.quote)}`, "");
  }
  const markdown = lines.join("\n");
  const visualSpecs = sections.flatMap(s=>(s.visuals??[]).map(v=>({section_id:s.id,...v})));
  return { ...input, sections, coverage, questions, standard_version: STANDARD_VERSION,
    input_hash: inputFingerprint(input.artifacts, input.evidence), content_hash: createHash("sha256").update(markdown + (visualSpecs.length ? fingerprint(visualSpecs) : '')).digest("hex"),
    conclusion_status: withheld ? "withheld" : qualified ? "qualified" : "ready_for_review", markdown };
}

export function assertReportApproval(document: ReportDocument, approval: { report_hash: string; input_hash: string } | null, currentInputHash: string) {
  if (!approval) throw new Error("Report approval is required");
  if (approval.report_hash !== document.content_hash || approval.input_hash !== document.input_hash || currentInputHash !== document.input_hash) {
    throw new Error("Report or research inputs changed; approval is stale. Review the current version.");
  }
}
