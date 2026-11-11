import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StandardFontEmbedder, StandardFonts } from "pdf-lib";

// Drawing primitives. Every figure type compiles to these; the SVG writer and the
// PDF writer both consume them.
export type Pt = [number, number];
export type Prim =
  | { k: "rect"; x: number; y: number; w: number; h: number; dash?: boolean }
  | { k: "polygon"; pts: Pt[] }
  | { k: "arrow"; pts: Pt[]; both?: boolean }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number }
  | { k: "text"; x: number; y: number; s: string; size: number; anchor: "start" | "middle" | "end"; bold: boolean; rotate?: number; num?: boolean };

export type Drawing = { width: number; height: number; prims: Prim[] };
export type Rendered = { number: number; file: string; svg: string; numerals: string[]; warnings: string[] };

// Helvetica's published metrics, used only to measure labels for layout and warnings.
type FontName = Parameters<typeof StandardFontEmbedder.for>[0];
const helv = StandardFontEmbedder.for(StandardFonts.Helvetica as unknown as FontName);
const helvB = StandardFontEmbedder.for(StandardFonts.HelveticaBold as unknown as FontName);
export function textWidth(s: string, size: number, bold = false): number {
  try {
    return (bold ? helvB : helv).widthOfTextAtSize(s, size);
  } catch {
    return s.length * size * 0.56;
  }
}

// ---------- primitives (same geometry as the original Python drawing script) ----------
const T = (x: number, y: number, s: string, size = 13, anchor: "start" | "middle" | "end" = "middle", bold = false, extra: Partial<Extract<Prim, { k: "text" }>> = {}): Prim => ({ k: "text", x, y, s, size, anchor, bold, ...extra });
const NUM = (x: number, y: number, s: string, anchor: "start" | "end") => T(x, y, s, 11, anchor, true, { num: true });

function lines(cx: number, cy: number, s: string, size = 13, lh = 16): Prim[] {
  const ls = s.split("\n");
  const y0 = cy - ((ls.length - 1) * lh) / 2 + size * 0.35;
  return ls.map((l, i) => T(cx, y0 + i * lh, l, size)).filter((p) => (p as { s: string }).s !== "");
}
function box(x: number, y: number, w: number, h: number, s: string, num?: string, dash = false, size = 13): Prim[] {
  const o: Prim[] = [{ k: "rect", x, y, w, h, dash }];
  o.push(...lines(x + w / 2, y + h / 2, s, size));
  if (num) o.push(NUM(x + w - 6, y + 14, num, "end"));
  return o;
}
function dia(cx: number, cy: number, w: number, h: number, s: string, num?: string): Prim[] {
  const o: Prim[] = [{ k: "polygon", pts: [[cx, cy - h / 2], [cx + w / 2, cy], [cx, cy + h / 2], [cx - w / 2, cy]] }];
  o.push(...lines(cx, cy, s, 12, 15));
  if (num) o.push(NUM(cx + w / 2 - 4, cy - h / 2 + 12, num, "start"));
  return o;
}
function arrow(pts: Pt[], label?: string, lx?: number, ly?: number, both = false): Prim[] {
  const o: Prim[] = [{ k: "arrow", pts, both }];
  if (label && lx !== undefined && ly !== undefined) o.push(T(lx, ly, label, 11));
  return o;
}
function table(x: number, y: number, w: number, title: string, num: string | undefined, rows: [string, string?][], rh = 24): Prim[] {
  const o: Prim[] = [
    { k: "rect", x, y, w, h: 30 + rh * rows.length },
    { k: "line", x1: x, y1: y + 30, x2: x + w, y2: y + 30 },
    T(x + 10, y + 20, title, 13, "start", true),
  ];
  if (num) o.push(NUM(x + w - 8, y + 20, num, "end"));
  rows.forEach(([k, n], i) => {
    const yy = y + 30 + rh * i + 16;
    o.push(T(x + 12, yy, k, 12, "start"));
    if (n) o.push(NUM(x + w - 8, yy, n, "end"));
  });
  return o;
}

function wrap(s: string, max: number, size: number): string {
  return s
    .split("\n")
    .map((line) => {
      if (textWidth(line, size) <= max) return line;
      const out: string[] = [];
      let cur = "";
      for (const word of line.split(/\s+/)) {
        const next = cur ? cur + " " + word : word;
        if (cur && textWidth(next, size) > max) {
          out.push(cur);
          cur = word;
        } else cur = next;
      }
      if (cur) out.push(cur);
      return out.join("\n");
    })
    .join("\n");
}
const nlines = (s: string) => s.split("\n").length;
const widest = (s: string, size: number) => Math.max(...s.split("\n").map((l) => textWidth(l, size)));

// ---------- flowchart ----------
type FlowStep = {
  n: string; text: string; decision?: boolean;
  side?: { n: string; text: string }; side_label?: string; down_label?: string;
  rejoin?: string; back_to?: string; back_label?: string;
};

function flow(fig: any, warn: (m: string) => void): Drawing {
  const steps: FlowStep[] = fig.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error(`FIG. ${fig.number}: a flow figure needs "steps".`);
  const cx = 290, w = 400;
  let y = 40;
  const o: Prim[] = [];
  let prev: { bot: number; lab: string | null } | null = null;
  const pend = new Map<string, { cy: number; bot: number }[]>();
  const sideBoxes: { top: number; bot: number }[] = [];
  let lanes = 0, width = 850;
  const placed = new Map<string, { top: number; bot: number; left: number }>();
  const backs: { from: FlowStep; fromY: number; fromLeft: number }[] = [];
  const ids = new Set(steps.map((s) => String(s.n)));

  steps.forEach((s, idx) => {
    if (s.n === undefined || typeof s.text !== "string") throw new Error(`FIG. ${fig.number}: step ${idx + 1} needs "n" and "text".`);
    s.n = String(s.n);
    let top: number, bot: number, lab: string | null, left: number;
    if (s.decision) {
      // Text in a diamond only has the width of the diamond at the text's own height.
      let t = s.text;
      for (let i = 0; i < 4; i++) {
        const n = nlines(t), hh = 46 + 18 * n;
        const avail = w * (1 - (15 * n + 2) / hh);
        const next = wrap(s.text, avail, 12);
        if (nlines(next) === n) { t = next; break; }
        t = next;
      }
      const n = nlines(t), hh = 46 + 18 * n, cy = y + hh / 2;
      if (widest(t, 12) > w * (1 - (15 * n + 2) / hh) + 6) warn(`FIG. ${fig.number} step ${s.n}: text is wider than the decision diamond; shorten it or add line breaks.`);
      o.push(...dia(cx, cy, w, hh, t, s.n));
      top = y; bot = y + hh; left = cx - w / 2;
      if (s.side) {
        const st = wrap(s.side.text, 230 - 14, 11);
        const sh = 30 + 16 * nlines(st);
        o.push(...box(560, cy - sh / 2, 230, sh, st, String(s.side.n), false, 11));
        sideBoxes.push({ top: cy - sh / 2, bot: cy + sh / 2 });
        o.push(...arrow([[cx + w / 2, cy], [560, cy]], s.side_label ?? "no", cx + w / 2 + 35, cy - 6));
        if (s.rejoin) {
          if (!ids.has(String(s.rejoin))) throw new Error(`FIG. ${fig.number} step ${s.n}: rejoin "${s.rejoin}" is not a step.`);
          const list = pend.get(String(s.rejoin)) ?? [];
          list.push({ cy, bot: cy + sh / 2 });
          pend.set(String(s.rejoin), list);
        }
      }
      lab = s.down_label ?? "yes";
    } else {
      const t = wrap(s.text, w - 10, 12);
      const hh = 26 + 17 * nlines(t);
      o.push(...box(cx - w / 2, y, w, hh, t, s.n, false, 12));
      top = y; bot = y + hh; lab = null; left = cx - w / 2;
      const list = pend.get(s.n) ?? [];
      pend.delete(s.n);
      list.forEach((p, i) => {
        const ty = y + hh / 2 + (i ? 6 * i : -6);
        // A return line that would run down through a later side box goes round the outside instead.
        if (sideBoxes.some((b) => b.top >= p.bot && b.top < ty)) {
          const fx = 815 + 12 * lanes++;
          width = Math.max(width, fx + 35);
          o.push(...arrow([[790, p.cy], [fx, p.cy], [fx, ty], [cx + w / 2, ty]]));
        } else o.push(...arrow([[675, p.bot], [675, ty], [cx + w / 2, ty]]));
      });
    }
    if (prev) {
      o.push(...arrow([[cx, prev.bot], [cx, top]]));
      if (prev.lab) o.push(T(cx + 22, prev.bot + 16, prev.lab, 11));
    }
    placed.set(s.n, { top, bot, left });
    if (s.back_to) backs.push({ from: s, fromY: (top + bot) / 2, fromLeft: left });
    prev = { bot, lab };
    y = bot + 30;
  });
  for (const [target] of pend) warn(`FIG. ${fig.number}: rejoin target ${target} is a decision or comes before its side box; the return arrow was not drawn.`);
  backs.forEach((b, i) => {
    const t = placed.get(String(b.from.back_to));
    if (!t) throw new Error(`FIG. ${fig.number} step ${b.from.n}: back_to "${b.from.back_to}" is not a step.`);
    const x = 62 - 14 * i, ty = (t.top + t.bot) / 2;
    o.push(...arrow([[b.fromLeft, b.fromY], [x, b.fromY], [x, ty], [t.left, ty]]));
    if (b.from.back_label) o.push(T(x + 4, (b.fromY + ty) / 2, b.from.back_label, 11, "start"));
  });
  return { width, height: fig.height ?? y + 50, prims: o };
}

// ---------- canvas: exact coordinates ----------
function canvas(fig: any, warn: (m: string) => void): Drawing {
  if (!fig.width || !fig.height || !Array.isArray(fig.items)) throw new Error(`FIG. ${fig.number}: a canvas figure needs "width", "height" and "items".`);
  const o: Prim[] = [];
  fig.items.forEach((it: any, i: number) => {
    const where = `FIG. ${fig.number} item ${i + 1}`;
    if (it.box) {
      const [x, y, w, h] = it.box;
      const size = it.size ?? 13;
      o.push(...box(x, y, w, h, it.text ?? "", it.num ? String(it.num) : undefined, !!it.dash, size));
      if (it.text && widest(it.text, size) > w - 4) warn(`${where}: "${it.text.split("\n")[0]}" is wider than its box.`);
    } else if (it.diamond) {
      const [cx, cy, w, h] = it.diamond;
      o.push(...dia(cx, cy, w, h, it.text ?? "", it.num ? String(it.num) : undefined));
    } else if (it.table) {
      const [x, y, w] = it.table;
      o.push(...table(x, y, w, it.title ?? "", it.num ? String(it.num) : undefined, it.rows ?? [], it.row_height ?? 24));
    } else if (it.arrow) {
      if (!Array.isArray(it.arrow) || it.arrow.length < 2) throw new Error(`${where}: an arrow needs at least two points.`);
      const [lx, ly] = it.label_at ?? [];
      if (it.label && lx === undefined) throw new Error(`${where}: an arrow label needs "label_at": [x, y].`);
      o.push(...arrow(it.arrow, it.label, lx, ly, !!it.both));
    } else if (typeof it.text === "string" && it.at) {
      o.push(T(it.at[0], it.at[1], it.text, it.size ?? 11, it.anchor ?? "middle", !!it.bold, { rotate: it.rotate, num: !!it.num }));
    } else throw new Error(`${where}: expected one of box, diamond, table, arrow, or text with "at".`);
  });
  return { width: fig.width, height: fig.height, prims: o };
}

// ---------- block diagram on a grid ----------
type Rect = { x: number; y: number; w: number; h: number };
function block(fig: any, warn: (m: string) => void): Drawing {
  const nodes: any[] = fig.nodes;
  if (!Array.isArray(nodes) || !nodes.length) throw new Error(`FIG. ${fig.number}: a block figure needs "nodes".`);
  const M = 50, GX = 90, GY = 64, PAD = 24;
  const cols: number[] = [], rowsH: number[] = [];
  const own = new Map<string, { w: number; h: number; text: string }>();
  for (const n of nodes) {
    if (!n.id || n.col === undefined || n.row === undefined) throw new Error(`FIG. ${fig.number}: every node needs "id", "col" and "row".`);
    n.colspan ??= 1; n.rowspan ??= 1;
    let w: number, h: number, text = "";
    if (Array.isArray(n.rows)) {
      w = Math.max(240, textWidth(n.title ?? "", 13, true) + 70, ...n.rows.map((r: string[]) => textWidth(r[0] ?? "", 12) + 70));
      h = 30 + 24 * n.rows.length;
    } else {
      text = wrap(n.text ?? "", 190 - 16, 13);
      w = Math.max(190, widest(text, 13) + 16);
      h = Math.max(60, 26 + 17 * nlines(text));
    }
    own.set(n.id, { w, h, text });
    if (n.colspan === 1) cols[n.col] = Math.max(cols[n.col] ?? 0, w);
    if (n.rowspan === 1) rowsH[n.row] = Math.max(rowsH[n.row] ?? 0, h);
  }
  for (const n of nodes) for (let c = n.col; c < n.col + n.colspan; c++) cols[c] ??= 190;
  for (const n of nodes) for (let r = n.row; r < n.row + n.rowspan; r++) rowsH[r] ??= 60;
  for (let c = 0; c < cols.length; c++) cols[c] ??= 60;
  for (let r = 0; r < rowsH.length; r++) rowsH[r] ??= 30;
  const colX = (c: number) => M + cols.slice(0, c).reduce((a, b) => a + b + GX, 0);
  const rowY = (r: number) => M + rowsH.slice(0, r).reduce((a, b) => a + b + GY, 0);
  const span = (from: number, n: number, sizes: number[], gap: number) => sizes.slice(from, from + n).reduce((a, b) => a + b, 0) + gap * (n - 1);

  const o: Prim[] = [];
  for (const f of fig.frames ?? []) {
    const [c0, c1] = f.cols, [r0, r1] = f.rows;
    const x = colX(c0) - PAD, y = rowY(r0) - PAD;
    const w = span(c0, c1 - c0 + 1, cols, GX) + 2 * PAD, h = span(r0, r1 - r0 + 1, rowsH, GY) + 2 * PAD;
    o.push({ k: "rect", x, y, w, h, dash: true });
    if (f.text) o.push(T(x + 12, y + h - 8, f.text, 11, "start", true));
    if (f.num) o.push(NUM(x + w - 10, y + h - 8, String(f.num), "end"));
  }
  const rect = new Map<string, Rect>();
  for (const n of nodes) {
    const sz = own.get(n.id)!;
    const cw = span(n.col, n.colspan, cols, GX), ch = span(n.row, n.rowspan, rowsH, GY);
    const x = colX(n.col), y0 = rowY(n.row);
    if (Array.isArray(n.rows)) {
      rect.set(n.id, { x, y: y0, w: cw, h: sz.h });
      o.push(...table(x, y0, cw, n.title ?? n.text ?? "", n.num ? String(n.num) : undefined, n.rows));
    } else {
      const h = n.rowspan > 1 ? ch : sz.h, y = y0 + (ch - h) / 2;
      rect.set(n.id, { x, y, w: cw, h });
      o.push(...box(x, y, cw, h, sz.text, n.num ? String(n.num) : undefined, !!n.dash));
    }
  }

  const edges: any[] = fig.edges ?? [];
  const pairCount = new Map<string, number>(), pairSeen = new Map<string, number>();
  const key = (e: any) => [e.from, e.to].sort().join("\u0000");
  for (const e of edges) pairCount.set(key(e), (pairCount.get(key(e)) ?? 0) + 1);
  for (const e of edges) {
    const a = rect.get(e.from), b = rect.get(e.to);
    if (!a || !b) throw new Error(`FIG. ${fig.number}: edge ${e.from} -> ${e.to} names a node that does not exist.`);
    const k = pairCount.get(key(e))!, i = pairSeen.get(key(e)) ?? 0;
    pairSeen.set(key(e), i + 1);
    const off = (i - (k - 1) / 2) * 22;
    const ox0 = Math.max(a.x, b.x), ox1 = Math.min(a.x + a.w, b.x + b.w);
    const oy0 = Math.max(a.y, b.y), oy1 = Math.min(a.y + a.h, b.y + b.h);
    let pts: Pt[], lx: number, ly: number, anchor: "start" | "middle" = "middle";
    if (ox1 > ox0 && oy1 <= oy0) {
      const x = (ox0 + ox1) / 2 + off, down = a.y < b.y;
      pts = [[x, down ? a.y + a.h : a.y], [x, down ? b.y : b.y + b.h]];
      lx = x + 6; ly = (pts[0][1] + pts[1][1]) / 2 + 4; anchor = "start";
    } else if (oy1 > oy0) {
      const y = (oy0 + oy1) / 2 + off, right = a.x < b.x;
      pts = [[right ? a.x + a.w : a.x, y], [right ? b.x : b.x + b.w, y]];
      lx = (pts[0][0] + pts[1][0]) / 2; ly = y - 6;
    } else {
      const right = a.x < b.x, down = a.y < b.y;
      const y = a.y + a.h / 2 + off, x = b.x + b.w / 2 + off;
      pts = [[right ? a.x + a.w : a.x, y], [x, y], [x, down ? b.y : b.y + b.h]];
      lx = (pts[0][0] + pts[1][0]) / 2; ly = y - 6;
    }
    for (const n of nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      const r = rect.get(n.id)!;
      for (let s = 0; s < pts.length - 1; s++) {
        const [x1, y1] = pts[s], [x2, y2] = pts[s + 1];
        if (Math.max(x1, x2) > r.x && Math.min(x1, x2) < r.x + r.w && Math.max(y1, y2) > r.y && Math.min(y1, y2) < r.y + r.h) {
          warn(`FIG. ${fig.number}: the arrow ${e.from} -> ${e.to} crosses the node "${n.id}". Move a node, or draw this figure as a canvas.`);
        }
      }
    }
    o.push({ k: "arrow", pts, both: !!e.both });
    if (e.label) o.push(T(lx, ly, e.label, 11, anchor));
  }

  const width = 2 * M + span(0, cols.length, cols, GX);
  let bottom = M + span(0, rowsH.length, rowsH, GY) + 30;
  for (const note of fig.notes ?? []) {
    bottom += 18;
    o.push(T(width / 2, bottom, note, 11));
    if (textWidth(note, 11) > width - 20) warn(`FIG. ${fig.number}: a note is wider than the drawing; split it into two notes.`);
  }
  return { width, height: bottom + 70, prims: o };
}

// ---------- SVG out ----------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const FONT = 'font-family="Helvetica, Arial, sans-serif"';

export function toSvg(d: Drawing, title: string): string {
  const { width: w, height: h } = d;
  const o = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    `<rect width="${w}" height="${h}" fill="#fff"/>`,
    '<defs><marker id="ar" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto-start-reverse"><path d="M0,0 L10,4 L0,8 z" fill="#000"/></marker></defs>',
  ];
  for (const p of [...d.prims, T(w / 2, h - 28, title, 16, "middle", true)]) {
    if (p.k === "rect") o.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="#fff" stroke="#000" stroke-width="1.5"${p.dash ? ' stroke-dasharray="6 4"' : ""}/>`);
    else if (p.k === "polygon") o.push(`<polygon points="${p.pts.map(([x, y]) => `${x},${y}`).join(" ")}" fill="#fff" stroke="#000" stroke-width="1.5"/>`);
    else if (p.k === "arrow") o.push(`<polyline points="${p.pts.map(([x, y]) => `${x},${y}`).join(" ")}" fill="none" stroke="#000" stroke-width="1.5" marker-end="url(#ar)"${p.both ? ' marker-start="url(#ar)"' : ""}/>`);
    else if (p.k === "line") o.push(`<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="#000" stroke-width="1.5"/>`);
    else o.push(`<text ${p.rotate ? `transform="rotate(${p.rotate} ${p.x} ${p.y})" ` : ""}${p.num ? 'class="num" ' : ""}x="${p.x}" y="${p.y}" ${FONT} font-size="${p.size}" text-anchor="${p.anchor}" font-weight="${p.bold ? "bold" : "normal"}" fill="#000">${esc(p.s)}</text>`);
  }
  o.push("</svg>");
  return o.join("\n");
}

// ---------- SVG in: reads back the subset this module writes ----------
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function parseSvg(svg: string): Drawing & { unsupported: string[] } {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!vb) throw new Error("SVG has no viewBox starting at 0 0.");
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/g, "");
  const prims: Prim[] = [];
  const unsupported: string[] = [];
  const re = /<(\w+)\b([^>]*?)(?:\/>|>([^<]*)<\/\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const [, tag, attrText, inner] = m;
    if (tag === "svg") continue;
    const a: Record<string, string> = {};
    for (const am of attrText.matchAll(/([\w-]+)="([^"]*)"/g)) a[am[1]] = am[2];
    const num = (k: string) => Number(a[k] ?? 0);
    const pts = (): Pt[] => (a.points ?? "").trim().split(/\s+/).map((p) => p.split(",").map(Number) as Pt);
    if (tag === "rect") {
      if (!a.stroke) continue; // page background
      prims.push({ k: "rect", x: num("x"), y: num("y"), w: num("width"), h: num("height"), dash: !!a["stroke-dasharray"] });
    } else if (tag === "polygon") prims.push({ k: "polygon", pts: pts() });
    else if (tag === "polyline") prims.push({ k: "arrow", pts: pts(), both: !!a["marker-start"] });
    else if (tag === "line") prims.push({ k: "line", x1: num("x1"), y1: num("y1"), x2: num("x2"), y2: num("y2") });
    else if (tag === "text") {
      const rot = a.transform?.match(/rotate\((-?[\d.]+)/);
      prims.push({
        k: "text", x: num("x"), y: num("y"), s: unesc(inner ?? ""), size: num("font-size") || 12,
        anchor: (a["text-anchor"] as "start" | "middle" | "end") ?? "start", bold: a["font-weight"] === "bold",
        rotate: rot ? Number(rot[1]) : undefined, num: a.class === "num",
      });
    } else if (!unsupported.includes(tag)) unsupported.push(tag);
  }
  return { width: Number(vb[1]), height: Number(vb[2]), prims, unsupported };
}

// Reference numerals of a figure: marked numerals, or any bold all-digit label.
export function numeralsOf(d: Drawing): string[] {
  const out = new Set<string>();
  for (const p of d.prims) if (p.k === "text" && /^\d{2,4}[a-z]?$/.test(p.s.trim()) && (p.num || (p.bold && p.size <= 12))) out.add(p.s.trim());
  return [...out].sort();
}

export function figureFiles(packet: string): { number: number; file: string; path: string }[] {
  const dir = join(packet, "figures");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => ({ f, m: f.match(/^FIG[._ -]?(\d+).*\.svg$/i) }))
    .filter((x) => x.m)
    .map((x) => ({ number: Number(x.m![1]), file: x.f, path: join(dir, x.f) }))
    .sort((a, b) => a.number - b.number);
}

// ---------- entry ----------
export function renderFigure(fig: any): Rendered {
  const warnings: string[] = [];
  const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
  if (!Number.isInteger(fig?.number) || fig.number < 1) throw new Error(`Every figure needs a whole "number" from 1 up.`);
  const d = fig.type === "flow" ? flow(fig, warn) : fig.type === "block" ? block(fig, warn) : fig.type === "canvas" ? canvas(fig, warn) : null;
  if (!d) throw new Error(`FIG. ${fig.number}: "type" is one of flow, block, canvas.`);
  for (const p of d.prims) {
    if (p.k === "text" && (p.x < 0 || p.x > d.width || p.y < 0 || p.y > d.height)) warn(`FIG. ${fig.number}: the text "${p.s}" falls outside the drawing.`);
    if (p.k === "text" && /[^\x20-\x7E -ÿ‐-…′″←-↓≤≥·]/.test(p.s)) warn(`FIG. ${fig.number}: the text "${p.s}" has an unusual character that may not print; use plain letters and symbols.`);
  }
  const slug = typeof fig.name === "string" ? fig.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48) : "";
  const file = `FIG${fig.number}${slug ? "_" + slug : ""}.svg`;
  return { number: fig.number, file, svg: toSvg(d, `FIG. ${fig.number}`), numerals: numeralsOf(d), warnings };
}

export function writeFigures(packet: string, figures: any[]): string {
  if (!Array.isArray(figures) || !figures.length) throw new Error(`Pass at least one figure.`);
  const dir = join(packet, "figures");
  mkdirSync(dir, { recursive: true });
  const rendered = figures.map(renderFigure);
  const numbers = rendered.map((r) => r.number);
  const dup = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (dup) throw new Error(`Two figures are both numbered ${dup}.`);

  // Keep the JSON beside the drawings so a figure can be corrected and redrawn.
  const srcPath = join(dir, "source.json");
  let src: any[] = [];
  try {
    if (existsSync(srcPath)) src = JSON.parse(readFileSync(srcPath, "utf8"));
  } catch {}
  src = [...src.filter((s) => !numbers.includes(s?.number)), ...figures].sort((a, b) => a.number - b.number);
  writeFileSync(srcPath, JSON.stringify(src, null, 2) + "\n");

  const out: string[] = [];
  for (const r of rendered) {
    for (const old of figureFiles(packet)) if (old.number === r.number && old.file !== r.file) unlinkSync(old.path);
    writeFileSync(join(dir, r.file), r.svg + "\n");
    out.push(`figures/${r.file} · numerals: ${r.numerals.join(" ") || "none"}`);
    for (const w of r.warnings) out.push(`  warning: ${w}`);
  }
  const all = figureFiles(packet).map((f) => `FIG. ${f.number}`).join(", ");
  out.push("", `Figures now in the packet: ${all}.`);
  if (rendered.some((r) => r.warnings.length)) out.push("Fix the warnings and call patty_figures again for those figures; the files are overwritten.");
  return out.join("\n");
}
