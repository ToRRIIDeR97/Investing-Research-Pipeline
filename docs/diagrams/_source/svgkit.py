"""Tiny SVG helper for script-free, theme-safe documentation diagrams."""
from xml.sax.saxutils import escape

FILL = {
    "ui": ("#e8f1fb", "#3b6ea8"),
    "api": ("#eef6ec", "#4a8a3f"),
    "worker": ("#fdf3e3", "#b07a1f"),
    "lib": ("#f3eefa", "#6f4fa3"),
    "store": ("#eaf4f4", "#2f7f7f"),
    "ext": ("#f4f4f4", "#666666"),
    "warn": ("#fdecec", "#b23b3b"),
    "plain": ("#ffffff", "#444444"),
    "zone": ("none", "#999999"),
}


class Svg:
    def __init__(self, w, h, title, desc):
        self.w, self.h = w, h
        self.parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'role="img" aria-labelledby="t d" font-family="Helvetica, Arial, sans-serif" font-size="13">',
            f'<title id="t">{escape(title)}</title><desc id="d">{escape(desc)}</desc>',
            '<defs>'
            '<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
            '<path d="M0,0 L10,5 L0,10 z" fill="#333"/></marker>'
            '<marker id="o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">'
            '<path d="M0,0 L10,5 L0,10" fill="none" stroke="#333"/></marker>'
            '</defs>',
            f'<rect x="0" y="0" width="{w}" height="{h}" fill="#ffffff"/>',
            f'<text x="16" y="26" font-size="16" font-weight="bold" fill="#111">{escape(title)}</text>',
        ]

    def text(self, x, y, s, size=13, weight="normal", anchor="start", fill="#222", italic=False):
        st = ' font-style="italic"' if italic else ""
        self.parts.append(
            f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" fill="{fill}"{st}>{escape(s)}</text>'
        )

    def box(self, x, y, w, h, title, lines=(), kind="plain", stereo=None, rx=6, dashed=False, title_size=13):
        fill, stroke = FILL[kind]
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.4"{dash}/>'
        )
        ty = y + 18
        if stereo:
            self.text(x + w / 2, ty, f"«{stereo}»", size=11, anchor="middle", fill="#555")
            ty += 16
        self.text(x + w / 2, ty, title, size=title_size, weight="bold", anchor="middle", fill="#111")
        ty += 17
        for ln in lines:
            self.text(x + w / 2, ty, ln, size=11.5, anchor="middle", fill="#333")
            ty += 15

    def zone(self, x, y, w, h, label, color="#999999", fill="none"):
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{color}" stroke-width="1.6" stroke-dasharray="8 5"/>'
        )
        self.text(x + 10, y + 18, label, size=12, weight="bold", fill=color)

    def line(self, pts, label=None, dashed=False, head="a", tail=None, lx=None, ly=None, color="#333", lanchor="middle"):
        d = " ".join(f"{'M' if i == 0 else 'L'}{px},{py}" for i, (px, py) in enumerate(pts))
        dash = ' stroke-dasharray="5 4"' if dashed else ""
        me = f' marker-end="url(#{head})"' if head else ""
        ms = f' marker-start="url(#{tail})"' if tail else ""
        self.parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.3"{dash}{me}{ms}/>')
        if label:
            if lx is None:
                (x1, y1), (x2, y2) = pts[len(pts) // 2 - 1], pts[len(pts) // 2]
                lx, ly = (x1 + x2) / 2, (y1 + y2) / 2 - 5
            for i, part in enumerate(label.split("\n")):
                self.parts.append(
                    f'<text x="{lx}" y="{ly + i * 13}" font-size="11" text-anchor="{lanchor}" fill="#222" '
                    f'stroke="#ffffff" stroke-width="3" paint-order="stroke">{escape(part)}</text>'
                )

    def state(self, x, y, w, h, name, kind="plain"):
        fill, stroke = FILL[kind]
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="1.4"/>')
        self.text(x + w / 2, y + h / 2 + 4, name, size=12, weight="bold", anchor="middle", fill="#111")

    def initial(self, x, y):
        self.parts.append(f'<circle cx="{x}" cy="{y}" r="7" fill="#222"/>')

    def final(self, x, y):
        self.parts.append(f'<circle cx="{x}" cy="{y}" r="9" fill="none" stroke="#222" stroke-width="1.5"/><circle cx="{x}" cy="{y}" r="5" fill="#222"/>')

    def diamond(self, cx, cy, label=None, r=14):
        self.parts.append(
            f'<path d="M{cx},{cy - r} L{cx + r},{cy} L{cx},{cy + r} L{cx - r},{cy} z" fill="#fff8dc" stroke="#8a6d00" stroke-width="1.3"/>'
        )
        if label:
            self.text(cx + r + 4, cy - r + 2, label, size=11, fill="#5a4700", italic=True)

    def raw(self, s):
        self.parts.append(s)

    def save(self, path):
        self.parts.append("</svg>")
        with open(path, "w") as f:
            f.write("\n".join(self.parts) + "\n")
