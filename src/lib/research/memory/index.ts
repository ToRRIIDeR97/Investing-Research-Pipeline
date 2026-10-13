// Research memory: structured passages, embeddings, run-scoped retrieval, the evidence graph and the needs that use them.
export { decodeHtmlEntities } from "./entities";
export { htmlToStructuredText, type BlockType } from "./blocks";
export { documentPassages, parseDocument, DEFAULT_PASSAGE_CHARS, type Passage, type ParsedDocument } from "./passages";
export { ensureDocumentIndexed, embedParse, indexDocumentContent, MEMORY_PARSER, MEMORY_PARSER_VERSION, type IndexResult } from "./indexing";
export { getEmbeddingProvider, cosineSimilarity, EMBEDDING_BATCH_SIZE, type EmbeddingProvider } from "./embeddings";
export { citedClaimIds, linkArtifactCitations, recordContradictions, graphPassages, CITATION_KEYS } from "./graph";
export {
  retrievePassages, openingPassages, runDocuments, periodHints, coversPeriod, phraseQuery,
  type CoverageGap, type PeriodHint, type RetrievalNeed, type RetrievalResult, type RetrievedPassage, type RunDocument,
} from "./retrieve";
export { FOUNDER_ORIGIN_NEED, FOUNDER_FILINGS_NEED, FOUNDER_NEED_KEYS, evidenceNeeds, evidencePassageBudget, headlineKpis, HEADLINE_KPIS, kpiArchetypes, kpiPhrases } from "./needs";
