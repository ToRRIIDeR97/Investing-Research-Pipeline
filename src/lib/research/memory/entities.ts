// HTML entity decoding for stored source text. HTML5 maps numeric references 128-159 through
// Windows-1252, which SEC filings use for curly quotes and dashes (&#146; is ’).

const WINDOWS_1252: Record<number, number> = {
  128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x02c6,
  137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152, 142: 0x017d, 145: 0x2018, 146: 0x2019, 147: 0x201c,
  148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02dc, 153: 0x2122, 154: 0x0161, 155: 0x203a,
  156: 0x0153, 158: 0x017e, 159: 0x0178,
};

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  hellip: "…", bull: "•", middot: "·", prime: "′", Prime: "″", dagger: "†", Dagger: "‡", permil: "‰",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", copy: "©", reg: "®", trade: "™", sect: "§", para: "¶",
  deg: "°", plusmn: "±", times: "×", divide: "÷", micro: "µ", frac14: "¼", frac12: "½", frac34: "¾",
  sup1: "¹", sup2: "²", sup3: "³", cent: "¢", pound: "£", yen: "¥", euro: "€", curren: "¤", iexcl: "¡",
  iquest: "¿", ordf: "ª", ordm: "º", shy: "", macr: "¯", acute: "´", cedil: "¸", uml: "¨", not: "¬",
  brvbar: "¦", minus: "−", le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", larr: "←", rarr: "→",
  uarr: "↑", darr: "↓", harr: "↔", check: "✓", zwnj: "", zwj: "", lrm: "", rlm: "",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", THORN: "Þ", szlig: "ß",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ", yuml: "ÿ", OElig: "Œ",
  oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜",
};

function codePoint(value: number): string {
  if (WINDOWS_1252[value]) return String.fromCodePoint(WINDOWS_1252[value]);
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "�";
  return String.fromCodePoint(value);
}

/** Decode named and numeric HTML entities; non-breaking spaces become plain spaces. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (match, decimal, hex, name) => {
      if (decimal) return codePoint(Number.parseInt(decimal, 10));
      if (hex) return codePoint(Number.parseInt(hex, 16));
      return NAMED[name] ?? match;
    })
    .replace(/ /g, " ");
}
