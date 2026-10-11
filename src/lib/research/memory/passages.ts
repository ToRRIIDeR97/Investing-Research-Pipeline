// Groups blocks into retrieval passages that never cross a section or page boundary.
import { contentBlocks, type Block, type BlockType } from "./blocks";

export interface Passage {
  index: number;
  text: string;
  sectionPath: string[];
  page: number | null;
  blockTypes: BlockType[];
  charStart: number;
  charEnd: number;
}

export interface ParsedDocument {
  /** Blocks joined by blank lines; passage offsets point into this text. */
  text: string;
  passages: Passage[];
}

export const DEFAULT_PASSAGE_CHARS = 2_400;

interface Piece { text: string; start: number; end: number }
interface Draft { parts: string[]; sectionPath: string[]; page: number | null; blockTypes: Set<BlockType>; start: number; end: number }

function hardSplit(piece: Piece, limit: number): Piece[] {
  const out: Piece[] = [];
  let rest = piece.text, offset = piece.start;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    out.push({ text: rest.slice(0, cut), start: offset, end: offset + cut });
    const skip = rest[cut] === " " ? 1 : 0;
    offset += cut + skip;
    rest = rest.slice(cut + skip);
  }
  if (rest) out.push({ text: rest, start: offset, end: offset + rest.length });
  return out;
}

/** Split an oversized block at sentence or line boundaries, never wider than limit. */
function splitBlock(text: string, start: number, splitBy: Block["splitBy"], limit: number): Piece[] {
  const separator = splitBy === "line" ? "\n" : " ";
  const units: Piece[] = [];
  const pattern = splitBy === "line" ? /[^\n]+/g : /\S.*?(?:[.!?…](?=\s|$)|$)/g;
  for (const match of text.matchAll(pattern)) {
    const unit = splitBy === "line" ? match[0] : match[0].trim();
    if (!unit) continue;
    const at = start + (match.index ?? 0) + (match[0].length - match[0].trimStart().length);
    units.push(...hardSplit({ text: unit, start: at, end: at + unit.length }, limit));
  }
  const pieces: Piece[] = [];
  for (const unit of units) {
    const last = pieces.at(-1);
    if (last && last.text.length + separator.length + unit.text.length <= limit) {
      last.text += separator + unit.text;
      last.end = unit.end;
    } else pieces.push({ ...unit });
  }
  return pieces;
}

export function parseDocument(content: string, mimeType: string, options: { maxChars?: number } = {}): ParsedDocument {
  const maxChars = Math.max(200, Math.floor(options.maxChars ?? DEFAULT_PASSAGE_CHARS));
  const blocks = contentBlocks(content, mimeType);
  const passages: Passage[] = [];
  const headings: Array<{ level: number; text: string }> = [];
  let text = "";
  // The open passage and the heading waiting to start the next one; held in an object because
  // the helpers below replace them.
  const state: { pending: { text: string; start: number } | null; current: Draft | null } = { pending: null, current: null };

  const flush = () => {
    const draft = state.current;
    if (draft?.parts.length) {
      passages.push({ index: passages.length, text: draft.parts.join("\n"), sectionPath: draft.sectionPath, page: draft.page,
        blockTypes: [...draft.blockTypes], charStart: draft.start, charEnd: draft.end });
    }
    state.current = null;
  };
  const open = (sectionPath: string[], page: number | null, start: number): Draft => {
    const draft: Draft = { parts: [], sectionPath, page, blockTypes: new Set(), start, end: start };
    // The first passage of a section starts with its heading.
    if (state.pending) {
      draft.parts.push(state.pending.text);
      draft.blockTypes.add("heading");
      draft.start = state.pending.start;
      draft.end = state.pending.start + state.pending.text.length;
      state.pending = null;
    }
    state.current = draft;
    return draft;
  };
  const length = () => state.current ? state.current.parts.join("\n").length : 0;

  for (const block of blocks) {
    const start = text.length ? text.length + 2 : 0;
    text = text.length ? `${text}\n\n${block.text}` : block.text;
    if (block.type === "heading") {
      flush();
      while (headings.length && headings.at(-1)!.level >= (block.level ?? 2)) headings.pop();
      headings.push({ level: block.level ?? 2, text: block.text });
      state.pending = { text: block.text, start };
      continue;
    }
    const sectionPath = headings.map(heading => heading.text);
    if (state.current && state.current.page !== block.page) flush();
    const room = (fresh: boolean) => maxChars - (fresh ? (state.pending ? state.pending.text.length + 1 : 0) : length() + 1);
    const draft = state.current;
    if (draft && block.text.length <= room(false)) {
      draft.parts.push(block.text);
      draft.blockTypes.add(block.type);
      draft.end = start + block.text.length;
      continue;
    }
    flush();
    const limit = Math.max(100, room(true));
    // Later pieces of a split table start with its first row (the column headers), so their cells keep a label.
    const newline = block.text.indexOf("\n");
    const header = block.type === "table" && newline > 0 && newline < limit / 2 ? block.text.slice(0, newline) : "";
    const pieces = block.text.length <= limit ? [{ text: block.text, start, end: start + block.text.length }]
      : splitBlock(block.text, start, block.splitBy, header ? limit - header.length - 1 : limit);
    for (const [index, piece] of pieces.entries()) {
      if (state.current) flush();
      const draft = open(sectionPath, block.page, piece.start);
      draft.parts.push(index > 0 && header ? `${header}\n${piece.text}` : piece.text);
      draft.blockTypes.add(block.type);
      draft.end = piece.end;
    }
  }
  flush();
  return { text, passages };
}

export function documentPassages(content: string, mimeType: string, options: { maxChars?: number } = {}): Passage[] {
  return parseDocument(content, mimeType, options).passages;
}
