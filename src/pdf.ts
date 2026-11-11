import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  PDFDocument, type PDFFont, type PDFPage, degrees,
  closePath, fillAndStroke, lineTo, moveTo, popGraphicsState, pushGraphicsState,
  setDashPattern, setFillingGrayscaleColor, setLineWidth, setStrokingGrayscaleColor, stroke, fill,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { parseSvg, type Prim, type Pt } from "./figures.ts";
import { VERSION } from "./packet.ts";

// Letter paper. USPTO accepts letter or A4 (Patent Center PDF Guidelines).
const PAGE_W = 612, PAGE_H = 792;
const CM = 72 / 2.54;

const require_ = createRequire(import.meta.url);
function fontBytes(family: string, variant: string): Uint8Array {
  const dir = dirname(require_.resolve(`@expo-google-fonts/${family}/package.json`));
  const name = family[0].toUpperCase() + family.slice(1);
  return readFileSync(join(dir, variant, `${name}_${variant}.ttf`));
}

// Patent Center wants every glyph embedded, PDF version 1.1 to 1.6, no encryption, no layers.
async function newDoc(title: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(title);
  doc.setProducer(`patty-mcp ${VERSION}`);
  doc.setCreator(`patty-mcp ${VERSION}`);
  return doc;
}
// pdf-lib always writes a 1.7 header. Nothing written here needs more than 1.6 (no object
// streams, no transparency), so the header is set to the version Patent Center accepts.
async function save(doc: PDFDocument): Promise<Uint8Array> {
  const bytes = await doc.save({ useObjectStreams: false });
  if (new TextDecoder().decode(bytes.subarray(0, 8)) === "%PDF-1.7") bytes[7] = 0x36;
  return bytes;
}

// Replaces characters the font cannot draw, and reports them.
function cleaner(font: PDFFont, missing: Set<string>) {
  const have = new Set(font.getCharacterSet());
  return (s: string) => {
    let out = "";
    for (const ch of s.replace(/\t/g, " ")) {
      if (have.has(ch.codePointAt(0)!)) out += ch;
      else {
        missing.add(ch);
        out += "?";
      }
    }
    return out;
  };
}

// ---------- specification ----------
type Style = "r" | "b" | "i" | "c";
type Block = { kind: "h1" | "h2" | "h3" | "p" | "li"; runs: { text: string; style: Style }[] };

function inline(text: string): { text: string; style: Style }[] {
  const out: { text: string; style: Style }[] = [];
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`|(?<![\w*])\*[^*\s][^*]*\*(?![\w*]))/)) {
    if (!part) continue;
    if (part.startsWith("**")) out.push({ text: part.slice(2, -2), style: "b" });
    else if (part.startsWith("`")) out.push({ text: part.slice(1, -1), style: "c" });
    else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) out.push({ text: part.slice(1, -1), style: "i" });
    else out.push({ text: part, style: "r" });
  }
  return out;
}

// Markdown subset: #, ##, ### headings, "- " bullets, paragraphs, **bold**, *italic*, `code`.
// Anything above the first "# " heading is notes and is left out of the filing copy.
export function specBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const first = lines.findIndex((l) => /^#\s/.test(l));
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", runs: inline(para.join(" ")) });
    para = [];
  };
  for (const raw of lines.slice(Math.max(first, 0))) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ kind: `h${h[1].length}` as "h1", runs: [{ text: h[2].replace(/[*`]/g, ""), style: "b" }] });
    } else if (li) {
      flush();
      blocks.push({ kind: "li", runs: inline(li[1]) });
    } else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}

export async function specPdf(md: string, title: string): Promise<{ bytes: Uint8Array; pages: number; warnings: string[] }> {
  const doc = await newDoc(title);
  // Fonts are embedded whole. pdf-lib's subsetting drops glyphs from these fonts, which
  // shows up as missing letters on the page while the text layer still reads correctly.
  const blocks = specBlocks(md);
  const used = new Set<Style>(blocks.flatMap((b) => b.runs.map((r) => r.style)));
  const regular = await doc.embedFont(fontBytes("tinos", "400Regular"));
  const fonts: Record<Style, PDFFont> = {
    r: regular,
    b: used.has("b") ? await doc.embedFont(fontBytes("tinos", "700Bold")) : regular,
    i: used.has("i") ? await doc.embedFont(fontBytes("tinos", "400Regular_Italic")) : regular,
    c: used.has("c") ? await doc.embedFont(fontBytes("arimo", "400Regular")) : regular,
  };
  const missing = new Set<string>();
  const clean: Record<Style, (s: string) => string> = { r: cleaner(fonts.r, missing), b: cleaner(fonts.b, missing), i: cleaner(fonts.i, missing), c: cleaner(fonts.c, missing) };

  // 37 CFR 1.52: margins of at least 2.0 cm top, right and bottom and 2.5 cm left; 1.5 line spacing; 12 pt.
  const M = 72, WIDTH = PAGE_W - 2 * M, LEAD = 18, BOTTOM = M;
  let page!: PDFPage, y = 0;
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M;
  };
  newPage();

  type Word = { text: string; style: Style; size: number; width: number; space: boolean };
  const layout = (b: Block, size: number, width: number): Word[][] => {
    const words: Word[] = [];
    for (const run of b.runs) {
      const font = fonts[run.style], sz = run.style === "c" ? size - 1.5 : size;
      const pieces = clean[run.style](run.text).split(/( +)/);
      for (const p of pieces) {
        if (!p) continue;
        if (/^ +$/.test(p)) {
          if (words.length) words[words.length - 1].space = true;
          continue;
        }
        words.push({ text: p, style: run.style, size: sz, width: font.widthOfTextAtSize(p, sz), space: false });
      }
    }
    const spaceW = fonts.r.widthOfTextAtSize(" ", size);
    const rows: Word[][] = [[]];
    let x = 0;
    for (const w of words) {
      const row = rows[rows.length - 1];
      const lead = row.length && row[row.length - 1].space ? spaceW : 0;
      if (row.length && x + lead + w.width > width) {
        rows.push([w]);
        x = w.width;
      } else {
        row.push(w);
        x += lead + w.width;
      }
    }
    return rows;
  };

  blocks.forEach((b, idx) => {
    const text = b.runs.map((r) => r.text).join("");
    const size = b.kind === "h1" ? 14 : 12;
    const indent = b.kind === "li" ? 18 : 0;
    const before = b.kind === "h1" ? 0 : b.kind === "h2" ? 14 : b.kind === "h3" ? 8 : 0;
    const after = b.kind === "h1" ? 14 : b.kind.startsWith("h") ? 2 : 8;
    // Claims and abstract each start on a new sheet (37 CFR 1.52(b)).
    if (b.kind === "h2" && /claims|^abstract/i.test(text) && y < PAGE_H - M) newPage();
    const rows = layout(b, size, WIDTH - indent);
    // Keep a heading with the first lines of what follows it.
    if (b.kind.startsWith("h") && y - before - rows.length * LEAD - 2 * LEAD < BOTTOM && idx < blocks.length - 1) newPage();
    if (y < PAGE_H - M) y -= before;
    const spaceW = fonts.r.widthOfTextAtSize(" ", size);
    rows.forEach((row, ri) => {
      if (y - LEAD < BOTTOM) newPage();
      y -= LEAD;
      const rowW = row.reduce((a, w, i) => a + w.width + (i && row[i - 1].space ? spaceW : 0), 0);
      let x = M + indent + (b.kind === "h1" ? (WIDTH - rowW) / 2 : 0);
      if (b.kind === "li" && ri === 0) page.drawText(clean.r("•"), { x: M + 4, y: y + 4, size: 12, font: fonts.r });
      row.forEach((w, i) => {
        if (i && row[i - 1].space) x += spaceW;
        page.drawText(w.text, { x, y: y + 4, size: w.size, font: fonts[w.style] });
        x += w.width;
      });
    });
    y -= after;
  });

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const s = String(i + 1), w = fonts.r.widthOfTextAtSize(s, 12);
    p.drawText(s, { x: (PAGE_W - w) / 2, y: 40, size: 12, font: fonts.r });
  });
  const warnings = missing.size ? [`specification.pdf: ${missing.size} character(s) the font cannot draw were replaced with "?": ${[...missing].map((c) => `${c} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`).join(", ")}. Replace them in SPECIFICATION.md and build again.`] : [];
  return { bytes: await save(doc), pages: pages.length, warnings };
}

// ---------- drawings ----------
export async function drawingsPdf(figures: { number: number; file: string; svg: string }[], title: string): Promise<{ bytes: Uint8Array; sheets: number; warnings: string[] }> {
  const doc = await newDoc(`${title}: drawings`);
  const reg = await doc.embedFont(fontBytes("arimo", "400Regular"));
  const bold = await doc.embedFont(fontBytes("arimo", "700Bold"));
  const missing = new Set<string>();
  const cleanR = cleaner(reg, missing), cleanB = cleaner(bold, missing);
  const warnings: string[] = [];

  // 37 CFR 1.84(g): margins of at least 2.5 cm top and left, 1.5 cm right, 1.0 cm bottom.
  const L = 2.5 * CM + 1, R = PAGE_W - 1.5 * CM - 1, T = PAGE_H - 2.5 * CM - 1, B = 1.0 * CM + 2;
  const HEAD = 26; // room for the sheet number at the top of the sight, 1.84(t)
  const areaW = R - L, areaH = T - HEAD - B;

  figures.forEach((f, idx) => {
    const d = parseSvg(f.svg);
    if (d.unsupported.length) warnings.push(`figures/${f.file}: elements Patty did not draw were left out (${d.unsupported.join(", ")}).`);
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const sheet = `${idx + 1}/${figures.length}`;
    page.drawText(sheet, { x: (L + R) / 2 - bold.widthOfTextAtSize(sheet, 13) / 2, y: T - 14, size: 13, font: bold });

    const sP = Math.min(areaW / d.width, areaH / d.height, 1);
    const sL = Math.min(areaH / d.width, areaW / d.height, 1);
    // A figure wider than the sheet is turned so the top of the sheet is on the right-hand side, 1.84(i).
    const turned = sL > sP * 1.15;
    const s = turned ? sL : sP;
    const P = turned
      ? (() => {
          const ox = L + (areaW - d.height * s) / 2, oy = B + (areaH - d.width * s) / 2;
          return (x: number, y: number): Pt => [ox + y * s, oy + x * s];
        })()
      : (() => {
          const ox = L + (areaW - d.width * s) / 2, top = T - HEAD;
          return (x: number, y: number): Pt => [ox + x * s, top - y * s];
        })();
    const dir = (dx: number, dy: number): Pt => (turned ? [dy, dx] : [dx, -dy]);

    const path = (pts: Pt[], close: boolean, mode: "stroke" | "fillStroke" | "fill", dash = false) => {
      const m = pts.map(([x, y]) => P(x, y));
      page.pushOperators(
        pushGraphicsState(),
        setLineWidth(1.5 * s),
        setStrokingGrayscaleColor(0),
        setFillingGrayscaleColor(mode === "fill" ? 0 : 1),
        setDashPattern(dash ? [6 * s, 4 * s] : [], 0),
        moveTo(m[0][0], m[0][1]),
        ...m.slice(1).map(([x, y]) => lineTo(x, y)),
        ...(close ? [closePath()] : []),
        mode === "stroke" ? stroke() : mode === "fill" ? fill() : fillAndStroke(),
        popGraphicsState(),
      );
    };
    const head = (from: Pt, to: Pt) => {
      const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
      const ux = (to[0] - from[0]) / len, uy = (to[1] - from[1]) / len;
      const tip: Pt = [to[0] + 1.5 * ux, to[1] + 1.5 * uy], base: Pt = [to[0] - 13.5 * ux, to[1] - 13.5 * uy];
      path([tip, [base[0] - 6 * uy, base[1] + 6 * ux], [base[0] + 6 * uy, base[1] - 6 * ux]], true, "fill");
    };

    for (const p of d.prims as Prim[]) {
      if (p.k === "rect") path([[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]], true, "fillStroke", p.dash);
      else if (p.k === "polygon") path(p.pts, true, "fillStroke");
      else if (p.k === "line") path([[p.x1, p.y1], [p.x2, p.y2]], false, "stroke");
      else if (p.k === "arrow") {
        path(p.pts, false, "stroke");
        const n = p.pts.length;
        if (n >= 2) {
          head(p.pts[n - 2], p.pts[n - 1]);
          if (p.both) head(p.pts[1], p.pts[0]);
        }
      } else {
        const font = p.bold ? bold : reg;
        const text = (p.bold ? cleanB : cleanR)(p.s);
        if (!text.trim()) continue;
        const size = p.size * s, w = font.widthOfTextAtSize(text, size);
        const rad = ((p.rotate ?? 0) * Math.PI) / 180;
        const [ux, uy] = dir(Math.cos(rad), Math.sin(rad));
        const k = p.anchor === "middle" ? 0.5 : p.anchor === "end" ? 1 : 0;
        const [ax, ay] = P(p.x, p.y);
        page.drawText(text, { x: ax - k * w * ux, y: ay - k * w * uy, size, font, rotate: degrees((Math.atan2(uy, ux) * 180) / Math.PI) });
      }
    }
    const smallest = Math.min(...d.prims.filter((p) => p.k === "text").map((p) => (p as { size: number }).size)) * s;
    if (smallest < 5) warnings.push(`figures/${f.file}: the smallest lettering prints at ${smallest.toFixed(1)} pt on the sheet. Split the figure in two or use fewer, larger boxes.`);
  });
  if (missing.size) warnings.push(`drawings.pdf: characters the font cannot draw were replaced with "?": ${[...missing].join(" ")}.`);
  return { bytes: await save(doc), sheets: figures.length, warnings };
}
