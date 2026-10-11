// Turns stored source content into ordered blocks (headings, paragraphs, tables, lists).
import { load } from "cheerio";
import { balancedHtml, tagAttribute } from "@/lib/html-scan";
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
  // The `hidden` attribute is not treated as hidden: streaming server rendering (React) delivers the
  // page body inside `<div hidden>` containers that scripts move into place.
  return SKIPPED.has(tag(node)) || styleOf(node).includes("display:none");
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
    // A loop, not a spread: a section can hold more rows than a call takes arguments.
    else if (["tbody", "thead", "tfoot"].includes(tag(child))) for (const row of rowsOf(child)) rows.push(row);
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
      // Rows written by htmlToStructuredText (cells joined by " | ") stay rows, so splits fall between them.
      if (paragraph.every(line => line.includes(" | "))) {
        blocks.push({ type: "table", text: paragraph.map(clean).join("\n"), page, splitBy: "line" });
        paragraph = [];
        return;
      }
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

// Implied-end elements that keep their tag when an untrusted page is rebuilt; the parser closes them.
const FLAT_KEPT = new Set(["p", "li", "dt", "dd", "br", "tr", "td", "th", "thead", "tbody", "tfoot", "caption"]);
// Table parts whose closing tags the rebuild drops (a caption's is followed by a cell instead), and
// the elements it follows with an empty cell, which tableText drops.
const TABLE_PARTS = new Set(["tr", "td", "th", "thead", "tbody", "tfoot", "caption"]);
const OPENS_CELL = new Set(["table", "tr", "thead", "tbody", "tfoot"]);
// Rebuilt pages nest at most this many kept elements; deeper ones contribute only their text.
const MAX_REBUILT_DEPTH = 64;

/**
 * Rebuilds an untrusted page from its balanced tag stream with only what htmlBlocks reads: block
 * tags, headings, tables, bold as a styled span, hidden elements dropped with their content, and
 * no other attributes. The parser then sees well-nested markup with no formatting elements, so
 * its adoption agency, formatting reconstruction and deep scope scans never run on hostile input.
 * Content inside a table always lands in a cell or caption: content between cells is moved in
 * front of the table one node at a time (foster parenting), which is quadratic in the node count.
 */
function rebuildHtml(html: string): string {
  const out: string[] = [];
  // Per open element: its end tag, "" when hidden, null when it was not written.
  const closers: (string | null)[] = [];
  let hidden = 0;
  let depth = 0;
  for (const event of balancedHtml(html)) {
    if (event.type === "text") {
      if (!hidden) out.push(event.text.replace(/</g, "&lt;"));
      continue;
    }
    if (event.type === "close") {
      const closer = closers.pop();
      if (closer === "") hidden--;
      else if (closer) {
        depth--;
        // An empty span changes no block, so it is dropped rather than parsed.
        if (closer === "span" && out[out.length - 1]?.startsWith("<span")) out.pop();
        else out.push(`</${closer}>`);
      }
      continue;
    }
    const { tag } = event;
    const style = (tagAttribute(tag, "style") || "").toLowerCase().replace(/\s+/g, "");
    const kept = style.includes("display:none") ? ' style="display:none"'
      : tag.name === "b" || tag.name === "strong" || /font-weight:(bold|bolder|[6-9]00)/.test(style) ? ' style="font-weight:bold"' : "";
    if (event.type === "flat") {
      if (hidden || !FLAT_KEPT.has(tag.name)) continue;
      // Terms and descriptions read the same as list items. Kept apart, each nests inside the
      // other without limit ('<li><dt><li>...'), and every insertion scans that depth.
      const name = tag.name === "dt" || tag.name === "dd" ? "li" : tag.name;
      if (!tag.closing) out.push(`<${name}${kept}>${OPENS_CELL.has(name) ? "<td>" : ""}`);
      // The next cell, row or section closes the others, so a closing tag never leaves table context.
      else if (name === "caption") out.push("</caption><td>");
      else if (!TABLE_PARTS.has(name)) out.push(`</${name}>`);
    } else if (hidden || SKIPPED.has(tag.name) || kept.includes("display:none")) {
      hidden++;
      closers.push("");
    } else {
      const name = CONTAINERS.has(tag.name) || HEADING.test(tag.name) || tag.name === "table" ? tag.name : kept ? "span" : null;
      if (!name || depth >= MAX_REBUILT_DEPTH) { closers.push(null); continue; }
      depth++;
      closers.push(name);
      out.push(`<${name}${kept}>${OPENS_CELL.has(name) ? "<td>" : ""}`);
    }
  }
  return out.join("");
}

/**
 * Structured plain text for an untrusted HTML page: headings as Markdown lines, blocks separated
 * by blank lines. Stored web pages stay readable and keep their sections when parsed again.
 */
export function htmlToStructuredText(html: string): string {
  return htmlBlocks(rebuildHtml(html))
    .map(block => block.type === "heading" ? `${"#".repeat(block.level || 2)} ${block.text}` : block.text)
    .join("\n\n");
}
