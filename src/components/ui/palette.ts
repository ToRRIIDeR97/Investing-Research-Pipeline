// Chart and SVG colours, the "consumer remaster" palette as values (SVG attributes and chart libraries can't read CSS
// variables reliably). Keep in step with the tokens in src/app/globals.css. Navy is the only accent over warm greys;
// green, red and amber mean good, bad and caution, nothing else, and only on small numbers and dots (their
// backgrounds are the neutral soft grey).
export const C = {
  ink: "#0D1B2A", ink2: "#44403C", ink3: "#78716C", ink4: "#A8A29E",
  line: "#E7E5DF", lineSoft: "#EEEDE7", lineStrong: "#D6D3CC", soft: "#F5F4EF", hover: "#F3F2EC", tile: "#FFFFFF",
  navy: "#0A2642", navy2: "#B4C0CC", navy3: "#3D5A78", navySoft: "#EEF1F5", sage: "#75937D",
  positive: "#2D7D46", positiveMid: "#5E9C70", positiveBg: "#F5F4EF",
  critical: "#C9302C", criticalMid: "#D9645F", criticalBg: "#F5F4EF",
  caution: "#B8860B", cautionMid: "#CDA349", cautionBg: "#F5F4EF",
} as const;

/** Series colours for multi-line charts: navy first, then lighter navy and warm grey steps. Never a status colour. */
export const SERIES = [C.navy, C.navy3, C.ink3, C.navy2, C.ink4] as const;
