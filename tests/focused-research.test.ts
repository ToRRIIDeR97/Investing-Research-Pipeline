import assert from 'node:assert/strict';
import test from 'node:test';
import { readableSourceText, readableTextChunks } from '../src/lib/research/sources/readable-text';
import { relevantExcerpt } from '../src/lib/research/pipeline-helpers';
import { createSourceReaderBatches, extractDeterministicEvidence, mergeSourceReaderOutputs } from '../src/lib/research/source-reader-batching';
import { scopedArtifactPacket, taskInputFingerprint } from '../src/lib/research/artifact-packets';
import { focusedReviewRepairPlan } from '../src/lib/research/review-repairs';
import { qualifiesForProviderCircuit } from '../src/lib/agent-harness/circuit-breaker';
import { generateMarkdownReport } from '../src/lib/export/report-generator';
import { reportNumericValues, reportSnapshotFingerprint, validateReportComposition, type ReportComposition } from '../src/lib/research/report-composition';

test('readable table preserves periods and values, rejects markup/staff-member false positives', () => {
  const raw = '<html><style>.members {left: 42px}</style><table><tr><th>March 31, 2026</th><th>March 31, 2025</th><th>Variance</th><th>% Change</th></tr>' +
    '<tr><td>Members</td><td>14,706,040</td><td>10,915,811</td><td>3,790,229</td><td>35</td><td>%</td></tr>' +
    '<tr><td>Total Products</td><td>22,159,146</td><td>15,915,425</td><td>6,243,721</td><td>39</td><td>%</td></tr></table></html>';
  const text = readableSourceText(raw);
  assert.doesNotMatch(text, /<[^>]+>|left:|42px/);
  const chunk = { source_id: 'source', document_chunk_id: 'chunk', char_start: 0, char_end: text.length, content_excerpt: text };
  const claims = extractDeterministicEvidence([chunk]);
  assert.equal(claims.length, 4);
  assert.deepEqual(claims.map((claim) => claim.period_end), ['2026-03-31', '2025-03-31', '2026-03-31', '2025-03-31']);
  assert.match(String(claims[0].claim_text), /14,706,040/);
  for (const claim of claims) assert.equal(text.slice(Number(claim.char_start), Number(claim.char_end)), claim.quoted_text);
  assert.equal(extractDeterministicEvidence([{ ...chunk, content_excerpt: raw }]).length, 0);
  assert.equal(extractDeterministicEvidence([{ ...chunk, content_excerpt: 'The Commission has 12 staff members as of 2026-03-31.' }]).length, 0);
  assert.equal(extractDeterministicEvidence([{ ...chunk, content_excerpt: 'Total Members 9000000' }]).length, 0);
  assert.equal(extractDeterministicEvidence([{ ...chunk, content_excerpt: 'Revenue discussed on March 31, 2026.' }]).length, 0);
  assert.equal(readableSourceText(JSON.stringify({ body: raw })), JSON.stringify({ body: raw }));
  for (const part of readableTextChunks(text, 120)) assert.equal(text.slice(part.start, part.end), part.text);
  const spanningTable = 'Context. '.repeat(995) + '\nMarch 31, 2026 | March 31, 2025\nMembers | 14,706,040 | 10,915,811\nTotal Products | 22,159,146 | 15,915,425';
  const parts = readableTextChunks(spanningTable);
  assert.ok(parts.some((part) => part.text.includes('March 31, 2026') && part.text.includes('Total Products | 22,159,146')));
  assert.throws(() => readableTextChunks(text, 0), /positive integer/);
});

test('retrieval retains a late matching passage and adjusts citation bounds', () => {
  const text = 'irrelevant '.repeat(600) + '\nMarch 31, 2026\nTotal Products | 22,159,146\n';
  const chunk = { id: 'chunk', sourceId: 'source', parseId: 'parse', chunkIndex: 1, charStart: 9000, charEnd: 9000 + text.length,
    text, sourceTitle: 'SOFI quarterly filing', sourceType: '10-Q' };
  const result = relevantExcerpt(chunk, ['Total Products'], 3000);
  assert.match(result.text, /22,159,146/);
  assert.match(result.text, /March 31, 2026/);
  assert.equal(text.slice(result.charStart - 9000, result.charEnd - 9000), result.text);
});

test('multiple excerpts from one chunk retain their own valid citations', () => {
  const chunks = [0, 100].map((start) => ({ source_id: 'source', document_chunk_id: 'chunk', char_start: start, char_end: start + 40,
    content_excerpt: `Exact supporting quotation ${start}.` }));
  const outputs = chunks.map((chunk) => ({ evidence_claims: [{ ...chunk, claim_text: chunk.content_excerpt,
    quoted_text: chunk.content_excerpt, char_end: Number(chunk.char_start) + chunk.content_excerpt.length }] }));
  assert.equal(mergeSourceReaderOutputs(outputs, createSourceReaderBatches(chunks)).evidence_claims.length, 2);
});

test('history task context excludes unrelated evidence and full compound schemas', () => {
  const packet = scopedArtifactPacket({ asset: { symbol: 'SOFI' }, output_schema: { huge: true },
    evidence_claims: [{ id: 'history', claim_text: 'The founder started the company.' }, { id: 'credit', claim_text: 'Credit losses increased.' }] }, 'founder_profile');
  assert.deepEqual((packet.evidence_claims as any[]).map((claim) => claim.id), ['history']);
  assert.equal(packet.output_schema, undefined);
  assert.equal(taskInputFingerprint({ b: 2, a: 1 }), taskInputFingerprint({ a: 1, b: 2 }));
  assert.notEqual(taskInputFingerprint({ a: 1 }), taskInputFingerprint({ a: 2 }));
});

test('targeted repairs exclude independent siblings and deterministic calculations', () => {
  const plan = focusedReviewRepairPlan([{ severity: 'blocker', artifact_refs: ['risk_register'] }])!;
  assert.ok(plan.artifacts.includes('investment_thesis'));
  assert.ok(!plan.artifacts.includes('catalyst_register'));
  assert.ok(plan.stages.includes('human_review'));
  assert.ok(!plan.stages.includes('company_genesis'));
  assert.equal(focusedReviewRepairPlan([{ severity: 'blocker', artifact_refs: ['expected_return_matrix'] }]), null);
  assert.equal(qualifiesForProviderCircuit('provider_timeout', 'total'), false);
  assert.equal(qualifiesForProviderCircuit('provider_timeout', 'inactivity'), true);
});

test('composer preserves every report section and resolves only saved numbers', () => {
  const artifacts = [{ artifact_type: 'expected_return_matrix', content_json: { base_return: 0.25 } }];
  const composition: ReportComposition = { executive_summary: 'The base return is {{value:expected_return_matrix.base_return}}.',
    closing_assessment: 'Human approval remains required.', section_order: Array.from({ length: 25 }, (_, index) => index + 1),
    transitions: [], disclosures: ['Assumptions remain uncertain.'], artifact_refs: ['expected_return_matrix'] };
  assert.deepEqual(validateReportComposition(composition, artifacts), []);
  const markdown = generateMarkdownReport({ runId: 'fixture', asset: { canonical_name: 'SOFI', slug: 'sofi', asset_kind: 'equity' },
    composition, compositionValues: reportNumericValues(artifacts) });
  assert.match(markdown, /The base return is 0.25\./);
  assert.equal(markdown.match(/^## \d+\./gm)?.length, 25);
  assert.ok(validateReportComposition({ ...composition, executive_summary: 'Return is 99%.' }, artifacts).length);
  assert.ok(validateReportComposition({ ...composition, executive_summary: '{{value:invented}}' }, artifacts).length);
  assert.ok(validateReportComposition({ ...composition, section_order: [1] }, artifacts).length);
  assert.notEqual(reportSnapshotFingerprint(artifacts), reportSnapshotFingerprint([{ ...artifacts[0], content_json: { base_return: 0.5 } }]));
});
