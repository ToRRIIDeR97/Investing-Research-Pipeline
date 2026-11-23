/** The Pragma mark: navy P and R with the sage arrow through them (paths from the Pragma web app's Logo; consumer remaster palette). */
export function PragmaMark({ size = 24 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 200 200" fill="none" aria-hidden="true" focusable="false">
    <mask id="pragma-mark-split">
      <rect width="100%" height="100%" fill="white" />
      <path d="M 62 95 L 88 95 Q 97 95, 106 86 L 187 5" stroke="white" strokeWidth="23" fill="none" />
      <rect x="0" y="0" width="60" height="200" fill="white" />
    </mask>
    <g mask="url(#pragma-mark-split)" fill="#0A2642">
      <path d="M 48 15 h 12 v 145 h -12 z" />
      <path d="M 60 15 H 84 A 44 42.5 0 0 1 117 85.61 V 160 H 105 V 94.85 A 44 42.5 0 0 1 84 100 H 60 V 88 H 84 A 30 30.5 0 0 0 84 27 H 60 Z" />
      <path d="M 117 40 H 132 A 30 32.5 0 0 1 148.08 99.64 L 181 160 H 167 L 136.68 104.41 A 30 32.5 0 0 1 132 105 H 117 V 93 H 132 A 18 20.5 0 0 0 132 52 H 117 Z" />
    </g>
    <path d="M 62 88 L 88 88 Q 94 88, 100 82 L 152 30 L 145 23 L 177 15 L 169 47 L 162 40 L 112 90 Q 100 102, 88 102 L 62 102 Z" fill="#75937D" />
  </svg>;
}
