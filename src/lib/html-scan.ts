// Linear-time scanning of untrusted HTML. A tag is matched with /<[^<>]*>/, which stops at the
// next '<', and an element's end is found with one forward search, so unclosed or deeply nested
// markup costs linear time. Backtracking patterns ([\s\S]*?, [^>]*> after another quantifier) were
// cubic on hostile pages. A DOM parser (parse5) given a hostile page is quadratic or worse in its
// nesting and misnesting, so callers parse only markup rebuilt from balancedHtml.

export type Tag = { name: string; closing: boolean; selfClosing: boolean; start: number; end: number; raw: string };

/** Every tag in document order. Comments, doctypes and a stray '<' are skipped. */
export function* scanTags(html: string): Generator<Tag> {
  const pattern = /<[^<>]*>/g;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const head = /^<(\/?)([a-z][a-z0-9:-]*)/i.exec(match[0]);
    if (!head) continue;
    yield {
      name: head[2].toLowerCase(), closing: head[1] === "/", selfClosing: match[0].endsWith("/>"),
      start: match.index, end: pattern.lastIndex, raw: match[0],
    };
  }
}

const attributePatterns = new Map<string, RegExp>();

/** The raw value of a tag attribute; entities are left for the caller to decode. */
export function tagAttribute(tag: Tag, name: string): string | undefined {
  let pattern = attributePatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`[\\s/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i");
    attributePatterns.set(name, pattern);
  }
  const match = pattern.exec(tag.raw);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

/** Where the element opened by `tag` closes, searching forward once; null when it never does. */
export function closingTag(html: string, tag: Tag): { start: number; end: number } | null {
  const close = new RegExp(`</${tag.name}\\s*>`, "gi");
  close.lastIndex = tag.end;
  const match = close.exec(html);
  return match ? { start: match.index, end: close.lastIndex } : null;
}

/** The content of the first `name` element that has a closing tag. */
export function firstElementBody(html: string, name: string): string | null {
  for (const tag of scanTags(html)) {
    if (tag.name !== name || tag.closing) continue;
    const close = closingTag(html, tag);
    // No close after the first opening tag means none after any later one either.
    return close ? html.slice(tag.end, close.start) : null;
  }
  return null;
}

/** Removes the named elements with their content. An element that never closes is left for the tag pass. */
export function dropElements(html: string, names: string[]): string {
  const open = new RegExp(`<(${names.join("|")})\\b`, "gi");
  const unclosed = new Set<string>();
  let kept = "";
  let from = 0;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    const name = match[1].toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`</${name}\\s*>`, "gi");
    close.lastIndex = open.lastIndex;
    const end = close.exec(html);
    if (!end) { unclosed.add(name); continue; }
    kept += `${html.slice(from, match.index)} `;
    from = open.lastIndex = close.lastIndex;
  }
  return kept + html.slice(from);
}

/** Removes comments; an unclosed one runs to the end, as a browser reads it. */
export function dropComments(html: string): string {
  let kept = "";
  let from = 0;
  for (let open = html.indexOf("<!--"); open !== -1; open = html.indexOf("<!--", from)) {
    kept += html.slice(from, open);
    // From open + 2 so that "<!-->" and "<!--->" close themselves.
    const close = html.indexOf("-->", open + 2);
    if (close === -1) return kept;
    from = close + 3;
  }
  return kept + html.slice(from);
}

// Elements that never nest: void elements and those whose end tag a parser implies.
const UNNESTED = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
  "p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "caption",
  "rb", "rt", "rp", "html", "head", "body",
]);

export type HtmlEvent =
  | { type: "text"; text: string }
  | { type: "flat"; tag: Tag }
  | { type: "open"; tag: Tag }
  | { type: "close"; name: string };

/**
 * The page as a properly nested stream: text, flat tags (void or implied-end elements, open or
 * closing), and open/close pairs. A close tag pops to its matching open tag and one with no match
 * is dropped; elements still open at the end are closed. Comments, scripts and styles are removed
 * first. Each element is pushed and popped once, so this is linear however misnested the page is.
 */
export function* balancedHtml(html: string): Generator<HtmlEvent> {
  const source = dropElements(dropComments(html), ["script", "style"]);
  const stack: string[] = [];
  const open = new Map<string, number>();
  let from = 0;
  // Doctypes, processing instructions and bogus comments are not text.
  const text = (end: number) => source.slice(from, end).replace(/<[!?/][^<>]*>/g, "");
  for (const tag of scanTags(source)) {
    const before = text(tag.start);
    if (before) yield { type: "text", text: before };
    from = tag.end;
    if (tag.selfClosing || UNNESTED.has(tag.name)) {
      yield { type: "flat", tag };
    } else if (!tag.closing) {
      stack.push(tag.name);
      open.set(tag.name, (open.get(tag.name) || 0) + 1);
      yield { type: "open", tag };
    } else if (open.get(tag.name)) {
      for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
        open.set(name, open.get(name)! - 1);
        yield { type: "close", name };
        if (name === tag.name) break;
      }
    }
  }
  const rest = text(source.length);
  if (rest) yield { type: "text", text: rest };
  for (let name = stack.pop(); name !== undefined; name = stack.pop()) yield { type: "close", name };
}
