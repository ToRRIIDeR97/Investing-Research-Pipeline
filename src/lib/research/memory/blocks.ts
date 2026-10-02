// Turns stored source content into ordered blocks (headings, paragraphs, tables, lists).
import { load } from "cheerio";
import { decodeHtmlEntities } from "./entities";

export type BlockType = "heading" | "paragraph" | "table" | "list";

export interface Block {
  type: BlockType;
  text: string;
  /** Heading level; lower is outer. */
  level?: number;
  page: number | null;
  /** How an oversized block may be split: at sentences, or only between lines. */
  splitBy: "sentence" | "line";
}

interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

const SKIPPED = new Set(["script", "style", "head", "noscript", "template", "svg", "iframe", "object", "title", "meta", "link", "ix:header"]);
const CONTAINERS = new Set(["address", "article", "aside", "blockquote", "body", "center", "dd", "div", "dl", "dt", "figcaption", "figure",
  "footer", "form", "header", "html", "li", "main", "nav", "ol", "p", "pre", "section", "ul"]);
const HEADING = /^h([1-6])$/;
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "per", "the", "to", "vs", "via", "with"]);

const clean = (value: string) => value.replace(/[\s ]+/g, " ").trim();
const styleOf = (node: DomNode) => (node.attribs?.style || "").toLowerCase().replace(/\s+/g, "");
const tag = (node: DomNode) => (node.name || "").toLowerCase();
const isElement = (node: DomNode) => node.type === "tag" || node.type === "script" || node.type === "style";

function skipped(node: DomNode): boolean {
  if (!isElement(node)) return false;
  return SKIPPED.has(tag(node)) || styleOf(node).includes("display:none") || node.attribs?.hidden !== undefined;
}

function isBold(node: DomNode): boolean {
  const name = tag(node);
  if (name === "b" || name === "strong") return true;
  return /font-weight:(bold|bolder|[6-9]00)/.test(styleOf(node));
}

function textOf(node: DomNode): string {
  if (node.type === "text") return node.data || "";
  if (!isElement(node) || skipped(node)) return "";
  if (tag(node) === "br") return " ";
  return (node.children || []).map(textOf).join("");
}

/** Text that is not inside a bold element; empty means the whole node is bold. */
function plainTextOf(node: DomNode): string {
  if (node.type === "text") return node.data || "";
  if (!isElement(node) || skipped(node) || isBold(node)) return "";
  return (node.children || []).map(plainTextOf).join("");
}

function containsBlocks(node: DomNode): boolean {
  return (node.children || []).some(child => isElement(child) && !skipped(child)
    && (CONTAINERS.has(tag(child)) || HEADING.test(tag(child)) || tag(child) === "table" || containsBlocks(child)));
}

/** Upper-case text is an outer heading; anything else sits one level below. */
const headingLevel = (text: string) => /[A-Za-z]/.test(text) && text === text.toUpperCase() ? 1 : 2;

function boldHeading(node: DomNode): string | null {
  if (containsBlocks(node)) return null;
  const text = clean(textOf(node));
  if (!text || text.length > 120 || text.endsWith(".") || !/[A-Za-z]/.test(text)) return null;
  return isBold(node) || !clean(plainTextOf(node)) ? text : null;
}

function rowsOf(table: DomNode): DomNode[] {
  const rows: DomNode[] = [];
  for (const child of table.children || []) {
    if (!isElement(child) || skipped(child)) continue;
    if (tag(child) === "tr") rows.push(child);
    else if (["tbody", "thead", "tfoot"].includes(tag(child))) rows.push(...rowsOf(child));
  }
  return rows;
}

function tableText(table: DomNode): string {
  return rowsOf(table)
    .map(row => (row.children || []).filter(cell => isElement(cell) && ["td", "th"].includes(tag(cell))).map(cell => clean(textOf(cell))).filter(Boolean).join(" | "))
    .filter(Boolean)
    .join("\n");
}

export function htmlBlocks(html: string): Block[] {
  const $ = load(html);
  const blocks: Block[] = [];
  let buffer = "";
  const flush = (type: BlockType = "paragraph") => {
    const text = clean(buffer);
    buffer = "";
    if (text) blocks.push({ type, text, page: null, splitBy: "sentence" });
  };
  const walk = (node: DomNode): void => {
    if (node.type === "text") { buffer += node.data || ""; return; }
    if (node.type === "root") { (node.children || []).forEach(walk); return; }
    if (!isElement(node) || skipped(node)) return;
    const name = tag(node);
    if (name === "br") { buffer += " "; return; }
    const heading = name.match(HEADING);
    if (heading) {
      flush();
      const text = clean(textOf(node));
      if (text) blocks.push({ type: "heading", text, level: Number(heading[1]), page: null, splitBy: "sentence" });
      return;
    }
    if (name === "table") {
      flush();
      const text = tableText(node);
      if (text) blocks.push({ type: "table", text, page: null, splitBy: "line" });
      return;
    }
    if (CONTAINERS.has(name)) {
      flush();
      if (name === "p" || name === "div") {
        const text = boldHeading(node);
        if (text) { blocks.push({ type: "heading", text, level: headingLevel(text), page: null, splitBy: "sentence" }); return; }
      }
      (node.children || []).forEach(walk);
      flush(name === "li" ? "list" : "paragraph");
      return;
    }
    (node.children || []).forEach(walk);
  };
  walk($.root()[0] as unknown as DomNode);
  flush();
  return blocks;
}

function isTitleCase(line: string): boolean {
  const words = line.split(/\s+/).filter(word => /[A-Za-z]/.test(word) && !/^\d/.test(word));
  if (!words.length) return false;
  return words.every((word, index) => {
    const letters = word.replace(/^[^A-Za-z]+/, "");
    if (index > 0 && SMALL_WORDS.has(letters.toLowerCase())) return true;
    return letters[0] === letters[0].toUpperCase();
  });
}

function textHeading(line: string): { text: string; level: number } | null {
  const markdown = line.match(/^(#{1,6})\s+(\S.*)$/);
  if (markdown) return { text: clean(markdown[2]), level: markdown[1].length };
  return null;
}

function standaloneHeading(line: string): { text: string; level: number } | null {
  if (line.length > 80 || /[.,;:!?]$/.test(line) || !/[A-Za-z]/.test(line)) return null;
  const upper = line === line.toUpperCase();
  if (!upper && !isTitleCase(line)) return null;
  return { text: line, level: upper ? 1 : 2 };
}

export function textBlocks(content: string): Block[] {
  const decoded = decodeHtmlEntities(content.replace(/\r\n?/g, "\n"));
  const paged = decoded.includes("\f");
  const blocks: Block[] = [];
  decoded.split("\f").forEach((pageText, pageIndex) => {
    const page = paged ? pageIndex + 1 : null;
    const lines = pageText.split("\n").map(line => line.trim());
    let paragraph: string[] = [];
    const flush = (endedByBlank: boolean) => {
      if (!paragraph.length) return;
      const standalone = paragraph.length === 1 && endedByBlank ? standaloneHeading(paragraph[0]) : null;
      if (standalone) blocks.push({ type: "heading", ...standalone, page, splitBy: "sentence" });
      else blocks.push({ type: "paragraph", text: clean(paragraph.join(" ")), page, splitBy: "sentence" });
      paragraph = [];
    };
    for (const line of lines) {
      if (!line) { flush(true); continue; }
      const heading = textHeading(line);
      if (heading) { flush(false); blocks.push({ type: "heading", ...heading, page, splitBy: "sentence" }); continue; }
      paragraph.push(line);
    }
    flush(false);
  });
  return blocks.filter(block => block.text);
}

export function jsonBlocks(content: string): Block[] | null {
  try {
    const text = JSON.stringify(JSON.parse(content), null, 2);
    return text && text !== "{}" && text !== "[]" ? [{ type: "paragraph", text, page: null, splitBy: "line" }] : [];
  } catch {
    return null;
  }
}

export function contentBlocks(content: string, mimeType: string): Block[] {
  if (!content.trim()) return [];
  if (/html|xml/i.test(mimeType)) return htmlBlocks(content);
  if (/json/i.test(mimeType)) return jsonBlocks(content) ?? textBlocks(content);
  return textBlocks(content);
}

/**
 * Structured plain text for an HTML page: headings as Markdown lines, blocks separated by
 * blank lines. Stored web pages stay readable and keep their sections when parsed again.
 */
export function htmlToStructuredText(html: string): string {
  return htmlBlocks(html)
    .map(block => block.type === "heading" ? `${"#".repeat(block.level || 2)} ${block.text}` : block.text)
    .join("\n\n");
}
