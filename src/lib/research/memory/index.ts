// Research memory: structured passages, run-scoped retrieval and the evidence needs that use it.
export { decodeHtmlEntities } from "./entities";
export { htmlToStructuredText, type BlockType } from "./blocks";
export { documentPassages, parseDocument, DEFAULT_PASSAGE_CHARS, type Passage, type ParsedDocument } from "./passages";
export { ensureDocumentIndexed, indexDocumentContent, MEMORY_PARSER, MEMORY_PARSER_VERSION, type IndexResult } from "./indexing";
export {
  retrievePassages, openingPassages, runDocuments,
  type CoverageGap, type RetrievalNeed, type RetrievalResult, type RetrievedPassage, type RunDocument,
} from "./retrieve";
export { FOUNDER_ORIGIN_NEED, evidenceNeeds } from "./needs";
