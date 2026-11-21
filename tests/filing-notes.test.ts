// Filing notes: the contract accepts a filing anchor, and report placement never mixes them into chapters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationCreate, type NotebookAnnotation } from "../src/lib/research/notebook/contracts";
import { filingNotes, placeAnnotation, placeAnnotations, reportNotes } from "../src/lib/research/notebook/readings";

const RUN = "11111111-1111-4111-8111-111111111111", DOC = "22222222-2222-4222-8222-222222222222";
const now = "2026-11-21T00:00:00.000Z";
const note = (over: Partial<NotebookAnnotation>): NotebookAnnotation => ({ id: "n", anchor_kind: "report", source_document_id: null, research_run_id: RUN,
  section_id: "risks", section_title: "Risks", section_coverage: ["risks"], exhibit_key: null, paragraph_index: null, quote: "", body: "b", created_at: now, updated_at: now, ...over });

test("the contract takes a report note or a filing note, and keeps them apart", () => {
  const filing = annotationCreate.parse({ anchor_kind: "filing", source_document_id: DOC, section_index: 3, section_title: " Risk\nFactors ", quote: "Credit losses", body: "Watch." });
  assert.deepEqual(filing, { anchor_kind: "filing", source_document_id: DOC, section_index: 3, section_title: "Risk Factors", quote: "Credit losses", body: "Watch." });
  const report = annotationCreate.parse({ research_run_id: RUN, section_id: "risks", body: "Watch." });
  assert.equal((report as { anchor_kind?: string }).anchor_kind, undefined);
  assert.equal(annotationCreate.safeParse({ anchor_kind: "filing", source_document_id: "x", section_index: 0, section_title: "T", body: "b" }).success, false);
  assert.equal(annotationCreate.safeParse({ anchor_kind: "filing", source_document_id: DOC, section_index: 0, section_title: "T", body: "b", section_coverage: ["risks"] }).success, false);
  assert.equal(annotationCreate.safeParse({ anchor_kind: "filing", source_document_id: DOC, section_index: 0, section_title: "", body: "b" }).success, false);
  assert.equal(annotationCreate.safeParse({ anchor_kind: "elsewhere", research_run_id: RUN, section_id: "risks", body: "b" }).success, false);
});

test("filing notes are never placed on report chapters, even one with the same id", () => {
  const document = { sections: [{ id: "risks", title: "Risks", coverage: ["risks"], exhibits: [] }, { id: "filing-1", title: "Odd", coverage: [], exhibits: [] }] } as never;
  const onFiling = note({ id: "f", anchor_kind: "filing", source_document_id: DOC, section_id: "filing-1", section_title: "Risk Factors", section_coverage: [] });
  const onReport = note({ id: "r" });
  assert.equal(placeAnnotation(onFiling, document, RUN).section_id, null);
  const placed = placeAnnotations([onFiling, onReport], document, RUN);
  assert.deepEqual(placed.bySection("risks").map((p) => p.annotation.id), ["r"]);
  assert.deepEqual(placed.bySection("filing-1"), []);
  assert.deepEqual(placed.unattached, []);
  assert.deepEqual(reportNotes([onFiling, onReport]).map((a) => a.id), ["r"]);
  assert.deepEqual(filingNotes([onFiling, onReport], DOC).map((a) => a.id), ["f"]);
  // A note stored before migration 0021 has no anchor_kind and is a report note.
  const legacy = { ...onReport, id: "l" } as NotebookAnnotation;
  delete (legacy as { anchor_kind?: string }).anchor_kind;
  assert.deepEqual(placeAnnotations([legacy], document, RUN).bySection("risks").map((p) => p.annotation.id), ["l"]);
});
