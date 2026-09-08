/** Canonical parse text. Citation offsets refer to this saved text, never raw HTML. */
export function readableSourceText(content: string): string {
  if (/^\s*[\[{]/.test(content)) {
    try { JSON.parse(content); return content; } catch { /* Not a structured JSON payload. */ }
  }
  if (!/<(?:html|body|table|div|p|span|script|style)\b/i.test(content)) return content;
  const entities: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    ndash: "-", mdash: "-", minus: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
  };
  // ponytail: text/table fallback, not layout reconstruction. Use Docling for complex visual tables.
  return content
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(script|style|noscript|ix:header)\b[^>]*>[^]*?<\/\1\s*>/gi, "")
    .replace(/<\/(?:td|th)\s*>\s*<(?:td|th)\b[^>]*>/gi, " | ")
    .replace(/<\/?(?:table|tr|p|div|h[1-6]|li|br|section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
      if (!key.startsWith("#")) return entities[key.toLowerCase()] ?? entity;
      const point = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    })
    .replace(/[\t\r \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** End chunks at paragraph/table boundaries where possible; keep exact parse offsets. */
export function readableTextChunks(text: string, maxCharacters = 9000) {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error('Chunk size must be a positive integer');
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + maxCharacters);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n\n", end);
      if (boundary > start + maxCharacters / 2) end = boundary + 2;
    }
    chunks.push({ text: text.slice(start, end), start, end });
    // ponytail: overlap retains nearby table headers; distant or visual headers need structured parsing.
    start = end === text.length ? end : Math.max(start + 1, end - Math.min(1500, Math.floor(maxCharacters / 3)));
  }
  return chunks;
}
