// Chart and SVG colours, the "Slate and navy" palette as values (SVG attributes and chart libraries can't read CSS
// variables reliably). Keep in step with the tokens in src/app/globals.css. Navy is the only accent; green, red and
// amber mean good, bad and caution, nothing else.
export const C = {
  ink: "#111827", ink2: "#4B5563", ink3: "#6B7280", ink4: "#9CA3AF",
  line: "#E2E5EA", lineSoft: "#EEF0F3", lineStrong: "#D1D5DB", soft: "#F1F3F6", hover: "#F7F8FA", tile: "#FFFFFF",
  navy: "#1E3A5F", navy2: "#B9C7D9", navy3: "#6B8CB5", navySoft: "#EDF0F4",
  positive: "#166534", positiveMid: "#3E8E5A", positiveBg: "#E6F4EA",
  critical: "#B42318", criticalMid: "#D0533F", criticalBg: "#FDECEC",
  caution: "#7A5300", cautionMid: "#B7791F", cautionBg: "#FFF4D6",
} as const;

/** Series colours for multi-line charts: navy first, then lighter navy and slate steps. */
export const SERIES = [C.navy, C.navy3, C.ink3, C.navy2, C.ink4] as const;
