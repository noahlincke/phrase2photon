import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(__dirname, "..");
const pdfPath = process.env.FB4_PACKET_PDF ?? "/tmp/fb4docs/FB4_Beam_Content_Pack_1.0.pdf";
const rawPackDir = process.env.FB4_CONTENT_PACK_DIR ?? resolve(homedir(), "Downloads", "FB4_Beam_Content_Pack_1");
const thumbnailsDir = resolve(runtimeRoot, "public", "fb4-thumbnails");
const generatedModulePath = resolve(runtimeRoot, "src", "dmx", "fb4CueCatalog.generated.ts");
const dryRun = process.argv.includes("--dry-run");

type Entry = {
  page: number;
  cue: number;
  category: string;
  name: string;
  description: string;
  source: "packet-generated" | "placeholder-generated";
  observedShape: string;
  notes: string;
  slug: string;
  thumbnailPath: string | null;
};

type InventoryCue = {
  page: number;
  cue: number;
};

type GeneratedThumbnail = {
  path: string;
  source: "packet-generated" | "placeholder-generated";
  notes: string;
};

type Band = {
  start: number;
  end: number;
};

type PageFamilyConfig = {
  page: number;
  category: string;
  cueCount: number;
  familyPrefix: string | null;
  baseNames: string[];
  placeholderFamilyLabel: string;
};

type GridSheetConfig = {
  kind: "grid-image";
  pdfPage: number;
  imageIndex: number;
  page: number;
  cueStart: number;
  cueCount: number;
  rows: number;
  columns: number;
  note: string;
};

type RenderedBandSheetConfig = {
  kind: "rendered-bands";
  pdfPage: number;
  page: number;
  cueStart: number;
  cueCount: number;
  rowBandStart: number;
  rows: number;
  columns: number;
  note: string;
};

type PacketSheetConfig = GridSheetConfig | RenderedBandSheetConfig;

const simpleBandLabels = [
  "Original",
  "Red",
  "Orange",
  "Yellow",
  "Teal",
  "Cyan",
  "Light Blue",
  "Dark Blue",
  "Purple",
  "Magenta",
  "Pink",
  "Negative Space White"
] as const;

const smoothShapeNames = [
  "Circle",
  "Horizontal line",
  "Triangle",
  "Square",
  "Single sine wave",
  "Triple sine wave",
  "Triple square wave",
  "Triple saw wave",
  "Small circles",
  "Single circles",
  "Vertical bars",
  "Box lines",
  "Cross",
  "X",
  "Star",
  "Target",
  "Boxy X",
  "Wide Boxy X",
  "Flower",
  "Orbit"
] as const;

const pointPatternNames = Array.from({ length: 20 }, (_, index) => `Pattern ${index + 1}`);

const simplePages: PageFamilyConfig[] = [
  { page: 1, category: "Smooth Simples Colors", cueCount: 240, familyPrefix: null, baseNames: [...smoothShapeNames], placeholderFamilyLabel: "Smooth Simples" },
  { page: 2, category: "Textured Simples Colored", cueCount: 240, familyPrefix: "Textured", baseNames: [...smoothShapeNames], placeholderFamilyLabel: "Textured Simples" },
  { page: 3, category: "Lined Points Simples Colored", cueCount: 240, familyPrefix: "Lined Point", baseNames: [...smoothShapeNames], placeholderFamilyLabel: "Lined Point Simples" },
  { page: 4, category: "Points Simples Color", cueCount: 240, familyPrefix: "Point Simples", baseNames: pointPatternNames, placeholderFamilyLabel: "Point Simples" }
];

const fullPackPages = [
  { page: 5, category: "Sheets", cueCount: 100 },
  { page: 6, category: "Waves", cueCount: 100 },
  { page: 7, category: "Cones", cueCount: 100 },
  { page: 8, category: "Spokes", cueCount: 100 },
  { page: 9, category: "Points", cueCount: 100 },
  { page: 10, category: "Mixed", cueCount: 40 }
] as const;

const packetSheets: PacketSheetConfig[] = [
  { kind: "rendered-bands", pdfPage: 13, page: 1, cueStart: 1, cueCount: 100, rowBandStart: 0, rows: 10, columns: 10, note: "Generated from Pangolin packet Smooth Simples Colors index." },
  { kind: "rendered-bands", pdfPage: 14, page: 2, cueStart: 1, cueCount: 100, rowBandStart: 0, rows: 10, columns: 10, note: "Generated from Pangolin packet Textured Simples Colored index." },
  { kind: "rendered-bands", pdfPage: 15, page: 2, cueStart: 101, cueCount: 100, rowBandStart: 0, rows: 10, columns: 10, note: "Generated from Pangolin packet Textured Simples Colored continuation." },
  { kind: "grid-image", pdfPage: 14, imageIndex: 1, page: 2, cueStart: 201, cueCount: 40, rows: 4, columns: 10, note: "Generated from Pangolin packet Textured Simples Colored tail index." },
  { kind: "rendered-bands", pdfPage: 16, page: 3, cueStart: 1, cueCount: 100, rowBandStart: 0, rows: 10, columns: 10, note: "Generated from Pangolin packet Lined Point Simples Colored index." },
  { kind: "rendered-bands", pdfPage: 17, page: 3, cueStart: 101, cueCount: 100, rowBandStart: 0, rows: 10, columns: 10, note: "Generated from Pangolin packet Lined Point Simples Colored continuation." },
  { kind: "grid-image", pdfPage: 16, imageIndex: 1, page: 3, cueStart: 201, cueCount: 40, rows: 4, columns: 10, note: "Generated from Pangolin packet Lined Point Simples Colored tail index." },
  { kind: "rendered-bands", pdfPage: 18, page: 4, cueStart: 1, cueCount: 100, rowBandStart: 0, rows: 10, columns: 10, note: "Generated from Pangolin packet Points Simples Color index." },
  { kind: "rendered-bands", pdfPage: 19, page: 4, cueStart: 101, cueCount: 100, rowBandStart: 0, rows: 10, columns: 10, note: "Generated from Pangolin packet Points Simples Color continuation." },
  { kind: "grid-image", pdfPage: 18, imageIndex: 1, page: 4, cueStart: 201, cueCount: 40, rows: 4, columns: 10, note: "Generated from Pangolin packet Points Simples Color tail index." },
  { kind: "grid-image", pdfPage: 21, imageIndex: 0, page: 5, cueStart: 1, cueCount: 100, rows: 10, columns: 10, note: "Generated from Pangolin packet Sheets index." },
  { kind: "grid-image", pdfPage: 22, imageIndex: 0, page: 6, cueStart: 1, cueCount: 100, rows: 10, columns: 10, note: "Generated from Pangolin packet Waves index." },
  { kind: "grid-image", pdfPage: 23, imageIndex: 0, page: 7, cueStart: 1, cueCount: 100, rows: 10, columns: 10, note: "Generated from Pangolin packet Cones index." },
  { kind: "grid-image", pdfPage: 24, imageIndex: 0, page: 8, cueStart: 1, cueCount: 100, rows: 10, columns: 10, note: "Generated from Pangolin packet Spokes index." },
  { kind: "grid-image", pdfPage: 25, imageIndex: 0, page: 9, cueStart: 1, cueCount: 100, rows: 10, columns: 10, note: "Generated from Pangolin packet Points index." },
  { kind: "grid-image", pdfPage: 26, imageIndex: 0, page: 10, cueStart: 1, cueCount: 40, rows: 4, columns: 10, note: "Generated from Pangolin packet Mixed index." }
];

const pdfImageCache = new Map<number, string[]>();
const renderedPageCache = new Map<number, string>();
const bandCache = new Map<string, { rows: Band[]; cols: Band[] }>();

function main(): void {
  const inventory = loadRawInventory();
  if (dryRun) {
    process.stdout.write(`Generated ${inventory.length} FB4 catalog entries (dry run).\n`);
    return;
  }

  mkdirSync(thumbnailsDir, { recursive: true });
  removeGeneratedThumbs(thumbnailsDir);

  const thumbnails = generatePacketThumbnails();
  for (const cue of inventory) {
    const key = cueKey(cue.page, cue.cue);
    if (!thumbnails.has(key)) {
      thumbnails.set(key, writePlaceholderThumbnail(cue));
    }
  }

  writeGeneratedModule(buildEntries(inventory, thumbnails));
  process.stdout.write(`Generated ${inventory.length} FB4 catalog entries.\n`);
}

function loadRawInventory(): InventoryCue[] {
  const files = readdirSync(rawPackDir)
    .filter((entry) => entry.endsWith(".FB4Animation"))
    .sort();

  const inventory = files.flatMap((entry) => {
    const match = entry.match(/^P(\d{3})C(\d{3})\.FB4Animation$/);
    if (!match) {
      return [];
    }
    return [{
      page: Number.parseInt(match[1], 10),
      cue: Number.parseInt(match[2], 10)
    }];
  });

  return inventory.sort((left, right) => left.page - right.page || left.cue - right.cue);
}

function generatePacketThumbnails(): Map<string, GeneratedThumbnail> {
  const generated = new Map<string, GeneratedThumbnail>();
  for (const sheet of packetSheets) {
    if (sheet.kind === "grid-image") {
      const imagePath = extractPdfImage(sheet.pdfPage, sheet.imageIndex);
      cropGridImage(imagePath, sheet, generated);
      continue;
    }
    const renderedPage = renderPdfPage(sheet.pdfPage);
    cropRenderedBands(renderedPage, sheet, generated);
  }
  return generated;
}

function buildEntries(inventory: InventoryCue[], thumbnails: Map<string, GeneratedThumbnail>): Entry[] {
  return inventory.map((cue) => {
    const thumbnail = thumbnails.get(cueKey(cue.page, cue.cue)) ?? null;
    const metadata = metadataForCue(cue.page, cue.cue);
    return {
      page: cue.page,
      cue: cue.cue,
      category: metadata.category,
      name: metadata.name,
      description: "",
      source: thumbnail?.source ?? "placeholder-generated",
      observedShape: metadata.observedShape,
      notes: thumbnail?.notes ?? `Generated placeholder for ${metadata.category}.`,
      slug: slugify(metadata.name),
      thumbnailPath: thumbnail?.path ?? null
    };
  });
}

function metadataForCue(page: number, cue: number): { category: string; name: string; observedShape: string; familyLabel: string; bandLabel: string | null } {
  const simpleConfig = simplePages.find((entry) => entry.page === page);
  if (simpleConfig) {
    const bandIndex = Math.floor((cue - 1) / simpleConfig.baseNames.length);
    const baseIndex = (cue - 1) % simpleConfig.baseNames.length;
    const bandLabel = simpleBandLabels[bandIndex] ?? "Unknown";
    const baseName = simpleConfig.baseNames[baseIndex] ?? `Cue ${cue}`;
    const familyName = simpleConfig.familyPrefix ? `${simpleConfig.familyPrefix} ${baseName}` : baseName;
    const name = bandLabel === "Original" ? familyName : `${familyName} / ${bandLabel}`;
    return {
      category: simpleConfig.category,
      name,
      observedShape: familyName.toLowerCase(),
      familyLabel: simpleConfig.placeholderFamilyLabel,
      bandLabel
    };
  }

  const fullPack = fullPackPages.find((entry) => entry.page === page);
  if (!fullPack) {
    throw new Error(`Unknown FB4 page ${page}.`);
  }

  return {
    category: fullPack.category,
    name: `${fullPack.category} Cue ${cue}`,
    observedShape: fullPack.category.toLowerCase(),
    familyLabel: fullPack.category,
    bandLabel: null
  };
}

function cropGridImage(sourceImage: string, sheet: GridSheetConfig, generated: Map<string, GeneratedThumbnail>): void {
  const { width, height } = imageSize(sourceImage);
  const columnWidth = width / sheet.columns;
  const rowHeight = height / sheet.rows;
  for (let offset = 0; offset < sheet.cueCount; offset += 1) {
    const row = Math.floor(offset / sheet.columns);
    const column = offset % sheet.columns;
    const left = Math.round(column * columnWidth);
    const top = Math.round(row * rowHeight);
    const nextLeft = Math.round((column + 1) * columnWidth);
    const nextTop = Math.round((row + 1) * rowHeight);
    writePngCrop({
      sourceImage,
      cropX: left + 1,
      cropY: top + 1,
      cropWidth: Math.max(1, nextLeft - left - 2),
      cropHeight: Math.max(1, nextTop - top - 3),
      dest: resolve(thumbnailsDir, pngFilename(sheet.page, sheet.cueStart + offset))
    });
    generated.set(cueKey(sheet.page, sheet.cueStart + offset), {
      path: `/${join("fb4-thumbnails", pngFilename(sheet.page, sheet.cueStart + offset)).replace(/\\/g, "/")}`,
      source: "packet-generated",
      notes: sheet.note
    });
  }
}

function cropRenderedBands(sourceImage: string, sheet: RenderedBandSheetConfig, generated: Map<string, GeneratedThumbnail>): void {
  const bands = detectBlackBands(sourceImage);
  const rowBands = bands.rows.slice(sheet.rowBandStart, sheet.rowBandStart + sheet.rows);
  if (rowBands.length !== sheet.rows || bands.cols.length < sheet.columns) {
    throw new Error(`Unable to detect grid bands for PDF page ${sheet.pdfPage}.`);
  }
  for (let offset = 0; offset < sheet.cueCount; offset += 1) {
    const row = Math.floor(offset / sheet.columns);
    const column = offset % sheet.columns;
    const rowBand = rowBands[row];
    const colBand = bands.cols[column];
    writePngCrop({
      sourceImage,
      cropX: colBand.start + 1,
      cropY: rowBand.start + 1,
      cropWidth: Math.max(1, colBand.end - colBand.start - 2),
      cropHeight: Math.max(1, rowBand.end - rowBand.start - 2),
      dest: resolve(thumbnailsDir, pngFilename(sheet.page, sheet.cueStart + offset))
    });
    generated.set(cueKey(sheet.page, sheet.cueStart + offset), {
      path: `/${join("fb4-thumbnails", pngFilename(sheet.page, sheet.cueStart + offset)).replace(/\\/g, "/")}`,
      source: "packet-generated",
      notes: sheet.note
    });
  }
}

function writePngCrop(input: { sourceImage: string; cropX: number; cropY: number; cropWidth: number; cropHeight: number; dest: string }): void {
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    input.sourceImage,
    "-vf",
    `crop=${input.cropWidth}:${input.cropHeight}:${input.cropX}:${input.cropY},scale=160:-1`,
    "-frames:v",
    "1",
    input.dest
  ], { stdio: "ignore" });
}

function writePlaceholderThumbnail(cue: InventoryCue): GeneratedThumbnail {
  const metadata = metadataForCue(cue.page, cue.cue);
  const bandLabel = metadata.bandLabel;
  const accent = accentColorForBand(bandLabel);
  const fileName = svgFilename(cue.page, cue.cue);
  const dest = resolve(thumbnailsDir, fileName);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="110" viewBox="0 0 160 110" role="img" aria-label="${escapeXml(`P${cue.page} C${cue.cue} placeholder thumbnail`)}">
  <rect width="160" height="110" rx="10" fill="#050b14"/>
  <rect x="1.5" y="1.5" width="157" height="107" rx="8.5" fill="none" stroke="${accent}" stroke-width="3"/>
  <rect x="0" y="0" width="160" height="24" fill="${accent}" fill-opacity="0.14"/>
  <text x="12" y="18" fill="#f8fafc" font-family="Helvetica, Arial, sans-serif" font-size="14" font-weight="700">P${cue.page} C${cue.cue}</text>
  <text x="12" y="48" fill="${accent}" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="700">${escapeXml(metadata.familyLabel)}</text>
  <text x="12" y="66" fill="#cbd5e1" font-family="Helvetica, Arial, sans-serif" font-size="11">${escapeXml(bandLabel ?? metadata.category)}</text>
  <text x="12" y="86" fill="#64748b" font-family="Helvetica, Arial, sans-serif" font-size="10">Raw pack only</text>
  <text x="12" y="98" fill="#64748b" font-family="Helvetica, Arial, sans-serif" font-size="10">No official packet thumbnail</text>
</svg>
`;
  writeFileSync(dest, svg, "utf8");
  return {
    path: `/${join("fb4-thumbnails", fileName).replace(/\\/g, "/")}`,
    source: "placeholder-generated",
    notes: `Generated placeholder for ${metadata.category}; raw content pack has no packet thumbnail for this cue.`
  };
}

function extractPdfImage(pdfPage: number, imageIndex: number): string {
  const cached = pdfImageCache.get(pdfPage);
  if (cached) {
    const match = cached[imageIndex];
    if (!match) {
      throw new Error(`No embedded image index ${imageIndex} for PDF page ${pdfPage}.`);
    }
    return match;
  }

  const workDir = mkdtempSync(join(tmpdir(), `fb4-pdf-${pdfPage}-`));
  execFileSync("pdfimages", ["-png", "-f", String(pdfPage), "-l", String(pdfPage), pdfPath, join(workDir, "image")], {
    stdio: "ignore"
  });
  const pngs = readdirSync(workDir)
    .filter((entry) => entry.endsWith(".png"))
    .map((entry) => join(workDir, entry))
    .sort();
  if (!pngs.length) {
    throw new Error(`No PNG images extracted for PDF page ${pdfPage}.`);
  }
  pdfImageCache.set(pdfPage, pngs);
  const match = pngs[imageIndex];
  if (!match) {
    throw new Error(`No embedded image index ${imageIndex} for PDF page ${pdfPage}.`);
  }
  return match;
}

function renderPdfPage(pdfPage: number): string {
  const cached = renderedPageCache.get(pdfPage);
  if (cached) {
    return cached;
  }
  const workDir = mkdtempSync(join(tmpdir(), `fb4-render-${pdfPage}-`));
  const outputBase = join(workDir, "page");
  execFileSync("pdftocairo", ["-png", "-f", String(pdfPage), "-l", String(pdfPage), "-singlefile", pdfPath, outputBase], {
    stdio: "ignore"
  });
  const imagePath = `${outputBase}.png`;
  renderedPageCache.set(pdfPage, imagePath);
  return imagePath;
}

function detectBlackBands(path: string): { rows: Band[]; cols: Band[] } {
  const cached = bandCache.get(path);
  if (cached) {
    return cached;
  }

  const { width, height } = imageSize(path);
  const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 64 * 1024 * 1024
  });
  const rowCounts = new Array<number>(height).fill(0);
  const colCounts = new Array<number>(width).fill(0);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const red = raw[offset];
      const green = raw[offset + 1];
      const blue = raw[offset + 2];
      if (red < 20 && green < 20 && blue < 20) {
        rowCounts[y] += 1;
        colCounts[x] += 1;
      }
      offset += 3;
    }
  }

  const bands = {
    rows: findBands(rowCounts, Math.floor(width * 0.35)),
    cols: findBands(colCounts, Math.floor(height * 0.18))
  };
  bandCache.set(path, bands);
  return bands;
}

function findBands(counts: number[], threshold: number): Band[] {
  const bands: Band[] = [];
  let start: number | null = null;
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] > threshold && start === null) {
      start = index;
    }
    if (counts[index] <= threshold && start !== null) {
      bands.push({ start, end: index - 1 });
      start = null;
    }
  }
  if (start !== null) {
    bands.push({ start, end: counts.length - 1 });
  }
  return bands;
}

function imageSize(path: string): { width: number; height: number } {
  const output = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
    encoding: "utf8"
  });
  const widthMatch = output.match(/pixelWidth:\s+(\d+)/);
  const heightMatch = output.match(/pixelHeight:\s+(\d+)/);
  if (!widthMatch || !heightMatch) {
    throw new Error(`Unable to determine image size for ${path}.`);
  }
  return {
    width: Number.parseInt(widthMatch[1], 10),
    height: Number.parseInt(heightMatch[1], 10)
  };
}

function removeGeneratedThumbs(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".png") || entry.endsWith(".svg")) {
      unlinkSync(join(dir, entry));
    }
  }
}

function writeGeneratedModule(entries: Entry[]): void {
  const source = `import type { Fb4CueCatalogEntry } from "./fb4CueCatalog.types.js";

export const fb4CueCatalogGenerated: Fb4CueCatalogEntry[] = ${JSON.stringify(entries, null, 2)};
`;
  writeFileSync(generatedModulePath, source, "utf8");
}

function accentColorForBand(bandLabel: string | null): string {
  switch (bandLabel) {
    case "Red":
      return "#ef4444";
    case "Orange":
      return "#f59e0b";
    case "Yellow":
      return "#eab308";
    case "Teal":
      return "#14b8a6";
    case "Cyan":
      return "#22d3ee";
    case "Light Blue":
      return "#60a5fa";
    case "Dark Blue":
      return "#2563eb";
    case "Purple":
      return "#8b5cf6";
    case "Magenta":
      return "#d946ef";
    case "Pink":
      return "#ec4899";
    case "Negative Space White":
      return "#f8fafc";
    case "Original":
      return "#94a3b8";
    default:
      return "#38bdf8";
  }
}

function cueKey(page: number, cue: number): string {
  return `${page}:${cue}`;
}

function pngFilename(page: number, cue: number): string {
  return `p${page}-c${cue}.png`;
}

function svgFilename(page: number, cue: number): string {
  return `p${page}-c${cue}.svg`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

main();
