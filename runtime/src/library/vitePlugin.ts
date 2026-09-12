import { createReadStream, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Plugin } from "vite";

import { handleDmxFrame, handleDmxHoldRelease, handleDmxStatus } from "../dmx/server.js";
import { buildFb4Dmx16Frame } from "../dmx/fb4Dmx16.js";
import { summarizeRekordboxMixer, type RekordboxSliderSample } from "./rekordboxMixer.js";
import { getLibraryTrack, loadLibraryRegistry, toPublicTrack } from "./service.js";
import type { LibraryTrack } from "./types.js";

const DEFAULT_NOW_PLAYING_BASE_URL = "http://127.0.0.1:8768";

export function phrase2PhotonLibraryPlugin(): Plugin {
  return {
    name: "phrase2photon-library",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          if (!req.url) {
            next();
            return;
          }

          const url = new URL(req.url, "http://localhost");
          if (req.method === "POST" && url.pathname === "/api/dmx/frame") {
            await handleDmxFrame(req, res);
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/dmx/status") {
            handleDmxStatus(res);
            return;
          }

          if (req.method === "POST" && url.pathname === "/api/dmx/hold/release") {
            handleDmxHoldRelease(res);
            return;
          }

          if (req.method === "POST" && url.pathname === "/api/dmx/cue-catalog/export") {
            const path = await exportCueCatalog(req);
            sendJson(res, { ok: true, path });
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/rekordbox/mixer") {
            sendJson(res, await probeRekordboxMixerSnapshot());
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/rekordbox/accessibility") {
            sendJson(res, await probeRekordboxAccessibilitySnapshot());
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/rekordbox/capabilities") {
            sendJson(res, await probeRekordboxCapabilities());
            return;
          }

          const nowPlayingAudioMatch = url.pathname.match(/^\/api\/now-playing\/audio\/([^/]+)$/);
          if ((req.method === "GET" || req.method === "HEAD") && nowPlayingAudioMatch) {
            await streamNowPlayingAudio(req, res, url);
            return;
          }

          if (url.pathname.startsWith("/api/now-playing/")) {
            await proxyNowPlayingRequest(req, res, url);
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/dmx/cue-catalog/exported") {
            const path = cueCatalogExportPath();
            const payload = JSON.parse(await readFile(path, "utf8"));
            sendJson(res, payload);
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/library") {
            const registry = await loadLibraryRegistry();
            sendJson(res, { tracks: registry.tracks.map(toPublicTrack) });
            return;
          }

          const showMatch = url.pathname.match(/^\/api\/library\/([^/]+)\/show$/);
          if (req.method === "GET" && showMatch) {
            const track = await getLibraryTrack(decodeURIComponent(showMatch[1]));
            if (!track) {
              sendJson(res, { error: "Unknown library track." }, 404);
              return;
            }
            const show = JSON.parse(await readFile(`${track.showPath}/show.json`, "utf8"));
            sendJson(res, show);
            return;
          }

          const exportShowMatch = url.pathname.match(/^\/api\/library\/([^/]+)\/export-show$/);
          if (req.method === "GET" && exportShowMatch) {
            const track = await getLibraryTrack(decodeURIComponent(exportShowMatch[1]));
            if (!track) {
              sendJson(res, { error: "Unknown library track." }, 404);
              return;
            }
            const show = JSON.parse(await readFile(`${track.showPath}/show.json`, "utf8"));
            const exported = buildLockedShowExport(track, show);
            const filename = `${track.id}-locked-show.json`;
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.end(`${JSON.stringify(exported, null, 2)}\n`);
            return;
          }

          const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
          if (req.method === "GET" && mediaMatch) {
            const track = await getLibraryTrack(decodeURIComponent(mediaMatch[1]));
            if (!track) {
              sendJson(res, { error: "Unknown media track." }, 404);
              return;
            }
            streamAudio(req, res, track.audioPath);
            return;
          }

          next();
        } catch (error) {
          next(error);
        }
      });
    }
  };
}

function nowPlayingServiceBaseUrl(): string {
  return process.env.PHRASE2PHOTON_NOW_PLAYING_BASE_URL?.trim() || DEFAULT_NOW_PLAYING_BASE_URL;
}

async function streamNowPlayingAudio(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  try {
    const upstreamUrl = new URL(url.pathname + url.search, nowPlayingServiceBaseUrl());
    const range = req.headers.range;

    if (req.method === "HEAD") {
      const headResponse = await fetch(upstreamUrl, { method: "HEAD" });
      if (headResponse.ok) {
        const contentType = headResponse.headers.get("content-type") || "application/octet-stream";
        const contentLength = totalSizeFromResponseHeaders(headResponse.headers);
        const headers: Record<string, number | string> = {
          "Content-Type": contentType,
          "Accept-Ranges": "bytes"
        };
        if (contentLength !== null) {
          headers["Content-Length"] = contentLength;
        }
        res.writeHead(200, headers);
        res.end();
        return;
      }

      const probeResponse = await fetch(upstreamUrl, {
        method: "GET",
        headers: { Range: "bytes=0-0" }
      });
      if (!probeResponse.ok) {
        sendJson(res, { error: "Now Playing audio not found." }, probeResponse.status);
        return;
      }
      const contentType = probeResponse.headers.get("content-type") || "application/octet-stream";
      const contentLength = totalSizeFromResponseHeaders(probeResponse.headers);
      if (probeResponse.body) {
        await probeResponse.body.cancel();
      }
      const headers: Record<string, number | string> = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes"
      };
      if (contentLength !== null) {
        headers["Content-Length"] = contentLength;
      }
      res.writeHead(200, headers);
      res.end();
      return;
    }

    if (range) {
      const rangedResponse = await fetch(upstreamUrl, {
        method: "GET",
        headers: { Range: range }
      });
      if (!rangedResponse.ok && rangedResponse.status !== 206) {
        sendJson(res, { error: "Now Playing audio not found." }, rangedResponse.status);
        return;
      }
      if (rangedResponse.status === 206 && rangedResponse.body) {
        res.statusCode = 206;
        rangedResponse.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });
        res.setHeader("Accept-Ranges", "bytes");
        await pipeline(Readable.fromWeb(rangedResponse.body as any), res);
        return;
      }

      const payload = new Uint8Array(await rangedResponse.arrayBuffer());
      const parsedRange = parseByteRange(range, payload.length);
      if (!parsedRange) {
        writeRangeNotSatisfiable(res, payload.length);
        return;
      }
      const { start, end } = parsedRange;
      const chunk = payload.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${payload.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunk.length,
        "Content-Type": rangedResponse.headers.get("content-type") || "application/octet-stream"
      });
      res.end(chunk);
      return;
    }

    const response = await fetch(upstreamUrl, { method: "GET" });
    if (!response.ok) {
      sendJson(res, { error: "Now Playing audio not found." }, response.status);
      return;
    }
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const contentLength = totalSizeFromResponseHeaders(response.headers);
    res.statusCode = response.status;
    res.setHeader("Content-Type", contentType);
    if (contentLength !== null) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("Accept-Ranges", "bytes");
    if (!response.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body as any), res);
  } catch (error) {
    if (!sendJsonIfWritable(
      res,
      {
        error: error instanceof Error ? error.message : "Now Playing audio proxy failed."
      },
      502
    )) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
}

function totalSizeFromResponseHeaders(headers: Headers): number | null {
  const contentRange = headers.get("content-range");
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    if (match) {
      const totalSize = Number.parseInt(match[1], 10);
      if (Number.isFinite(totalSize)) {
        return totalSize;
      }
    }
  }

  const contentLength = Number.parseInt(headers.get("content-length") || "", 10);
  if (Number.isFinite(contentLength)) {
    return contentLength;
  }
  return null;
}

async function proxyNowPlayingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  try {
    const upstreamUrl = new URL(url.pathname + url.search, nowPlayingServiceBaseUrl());
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key, value]) => {
      if (key.toLowerCase() === "host" || value === undefined) {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry) => headers.append(key, entry));
        return;
      }
      headers.set(key, value);
    });

    const requestInit: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      requestInit.body = Readable.toWeb(req) as BodyInit;
      requestInit.duplex = "half";
    }

    const response = await fetch(upstreamUrl, requestInit);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    if (!response.body || req.method === "HEAD") {
      res.end();
      return;
    }

    await pipeline(Readable.fromWeb(response.body as any), res);
  } catch (error) {
    if (!sendJsonIfWritable(
      res,
      {
        error: error instanceof Error ? error.message : "Now Playing proxy failed."
      },
      502
    )) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
}

function parseByteRange(range: string, totalSize: number): { start: number; end: number } | null {
  if (totalSize <= 0) {
    return null;
  }

  const match = range.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return null;
  }

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) {
    return null;
  }

  if (!startRaw) {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const clampedLength = Math.min(suffixLength, totalSize);
    return {
      start: totalSize - clampedLength,
      end: totalSize - 1
    };
  }

  const start = Number.parseInt(startRaw, 10);
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) {
    return null;
  }

  if (!endRaw) {
    return { start, end: totalSize - 1 };
  }

  const parsedEnd = Number.parseInt(endRaw, 10);
  if (!Number.isFinite(parsedEnd) || parsedEnd < start) {
    return null;
  }

  return {
    start,
    end: Math.min(parsedEnd, totalSize - 1)
  };
}

function writeRangeNotSatisfiable(res: ServerResponse, totalSize: number): void {
  res.writeHead(416, {
    "Content-Range": `bytes */${totalSize}`,
    "Accept-Ranges": "bytes"
  });
  res.end();
}

function buildLockedShowExport(track: LibraryTrack, show: any): unknown {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportType: "phrase2photon-locked-runtime-show",
    track: {
      id: track.id,
      title: track.title,
      artist: track.artist,
      bpm: track.bpm,
      abletonProjectPath: track.abletonProjectPath,
      audioPath: track.audioPath,
      showPath: track.showPath
    },
    show,
    fb4Dmx16: {
      profile: "pangolin-fb4-dmx16",
      dynamicChannels: {
        9: "Angle Z is beat/phrase-progress animated at runtime."
      },
      phraseFrames: show.phrases.map((phrase: any) => {
        const lightingCue = show.lighting_cues.find((cue: any) => cue.phrase_id === phrase.phrase_id) ?? null;
        const laserCue = show.dmx_laser_cues.find(
          (cue: any) => cue.phrase_id === phrase.phrase_id && cue.parameter_overrides?.page && cue.parameter_overrides?.cue
        ) ?? null;
        const frame = buildFb4Dmx16Frame({
          show,
          phrase,
          lightingCue,
          laserCue,
          phraseProgress: 0
        });
        return {
          phraseId: phrase.phrase_id,
          phraseName: phrase.name,
          lightingCueId: lightingCue?.cue_id ?? null,
          page: frame.page,
          cue: frame.cue,
          cueShape: frame.cueShape,
          label: frame.label,
          palette: frame.palette,
          colorMode: frame.colorMode,
          colorLabel: frame.colorLabel,
          colorValue: frame.colorValue,
          graphicsColor: frame.graphicsColor,
          channels: frame.channels,
          labels: frame.labels
        };
      })
    }
  };
}

function sendJson(res: ServerResponse, payload: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export function sendJsonIfWritable(res: ServerResponse, payload: unknown, statusCode = 200): boolean {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    return false;
  }
  sendJson(res, payload, statusCode);
  return true;
}

async function exportCueCatalog(req: IncomingMessage): Promise<string> {
  const body = await readRequestBody(req);
  const parsed = JSON.parse(body) as unknown;
  const path = cueCatalogExportPath();
  const dir = join(homedir(), "Phrase2PhotonShows", "exports");
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path;
}

function cueCatalogExportPath(): string {
  return join(homedir(), "Phrase2PhotonShows", "exports", "fb4-cue-catalog.json");
}

async function probeRekordboxMixerSnapshot(): Promise<{
  lineFaders: number[];
  highestLineFader: number | null;
  observedAt: string | null;
}> {
  const observedAt = new Date().toISOString();
  try {
    const [valuesRaw, positionsRaw, sizesRaw] = await Promise.all([
      runOsaScript("tell application \"System Events\" to tell process \"rekordbox\" to get value of every slider of UI element 2 of window 1"),
      runOsaScript("tell application \"System Events\" to tell process \"rekordbox\" to get position of every slider of UI element 2 of window 1"),
      runOsaScript("tell application \"System Events\" to tell process \"rekordbox\" to get size of every slider of UI element 2 of window 1")
    ]);
    const values = parseFlatNumberList(valuesRaw);
    const positions = pairFlatNumbers(parseFlatNumberList(positionsRaw));
    const sizes = pairFlatNumbers(parseFlatNumberList(sizesRaw));
    const sliderCount = Math.min(values.length, positions.length, sizes.length);
    const sliders: RekordboxSliderSample[] = [];
    for (let index = 0; index < sliderCount; index += 1) {
      sliders.push({
        value: values[index] ?? 0,
        x: positions[index]?.[0] ?? 0,
        y: positions[index]?.[1] ?? 0,
        width: sizes[index]?.[0] ?? 0,
        height: sizes[index]?.[1] ?? 0
      });
    }
    return summarizeRekordboxMixer(sliders, observedAt);
  } catch {
    return {
      lineFaders: [],
      highestLineFader: null,
      observedAt
    };
  }
}

async function probeRekordboxAccessibilitySnapshot(): Promise<{
  observedAt: string;
  windowName: string | null;
  windowPosition: [number, number] | null;
  windowSize: [number, number] | null;
  windowNames: string[];
  topLevelRoles: string[];
  buttonNames: string[];
  timeCandidates: string[];
  staticTextValues: string[];
}> {
  const observedAt = new Date().toISOString();
  const [windowNameResult, windowPositionResult, windowSizeResult, topLevelRolesResult, buttonNamesResult, staticTextsResult] =
    await Promise.allSettled([
      runOsaScript("tell application \"System Events\" to tell process \"rekordbox\" to get name of window 1"),
      runOsaScript("tell application \"System Events\" to tell process \"rekordbox\" to get position of window 1 as text"),
      runOsaScript("tell application \"System Events\" to tell process \"rekordbox\" to get size of window 1 as text"),
      runOsaScript([
        "set AppleScript's text item delimiters to linefeed",
        "tell application \"System Events\" to tell process \"rekordbox\" to get role of every UI element of window 1 as text"
      ].join("\n")),
      runOsaScript([
        "set AppleScript's text item delimiters to linefeed",
        "tell application \"System Events\" to tell process \"rekordbox\" to get name of every button of UI element 2 of window 1 as text"
      ].join("\n")),
      runOsaScript([
        "set AppleScript's text item delimiters to linefeed",
        "tell application \"System Events\" to tell process \"rekordbox\" to get value of every static text of UI element 2 of window 1 as text"
      ].join("\n"))
    ]);
  const staticTextValues =
    staticTextsResult.status === "fulfilled" ? splitOsaLines(staticTextsResult.value) : [];
  const timeCandidates = Array.from(
    new Set(
      staticTextValues.flatMap((value) => value.match(/[+-]?\d{1,2}:\d{2}(?:\.\d+)?/g) ?? [])
    )
  );
  return {
    observedAt,
    windowName: windowNameResult.status === "fulfilled" ? windowNameResult.value || null : null,
    windowPosition:
      windowPositionResult.status === "fulfilled" ? parsePair(windowPositionResult.value) : null,
    windowSize:
      windowSizeResult.status === "fulfilled" ? parsePair(windowSizeResult.value) : null,
    windowNames: windowNameResult.status === "fulfilled" && windowNameResult.value ? [windowNameResult.value] : [],
    topLevelRoles:
      topLevelRolesResult.status === "fulfilled" ? splitOsaLines(topLevelRolesResult.value) : [],
    buttonNames:
      buttonNamesResult.status === "fulfilled" ? splitOsaLines(buttonNamesResult.value) : [],
    timeCandidates,
    staticTextValues
  };
}

async function probeRekordboxCapabilities(): Promise<{
  appPath: string;
  installedVersion: string | null;
  hasGetTaskAllow: boolean;
  macosMemoryOffsetsAvailable: string[];
  likelyMemoryPathReady: boolean;
}> {
  const appPath = "/Applications/rekordbox 7/rekordbox.app";
  const [versionResult, entitlementsResult] = await Promise.allSettled([
    runCommand("defaults", ["read", `${appPath}/Contents/Info`, "CFBundleShortVersionString"]),
    runCommand("codesign", ["-d", "--entitlements", ":-", appPath])
  ]);
  const installedVersion =
    versionResult.status === "fulfilled" && versionResult.value.trim().length
      ? versionResult.value.trim()
      : null;
  const entitlementsText =
    entitlementsResult.status === "fulfilled" ? entitlementsResult.value : "";
  const hasGetTaskAllow = entitlementsText.includes("com.apple.security.get-task-allow");
  const macosMemoryOffsetsAvailable = ["7.2.8"];
  const likelyMemoryPathReady =
    installedVersion !== null &&
    macosMemoryOffsetsAvailable.includes(installedVersion) &&
    hasGetTaskAllow;
  return {
    appPath,
    installedVersion,
    hasGetTaskAllow,
    macosMemoryOffsetsAvailable,
    likelyMemoryPathReady
  };
}

async function runOsaScript(script: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return await new Promise<string>((resolve, reject) => {
    execFile("osascript", ["-e", script], { encoding: "utf8", timeout: 1500 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  return await new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 3000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout}${stderr}`.trim());
    });
  });
}

function splitOsaLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "missing value");
}

function parsePair(raw: string): [number, number] | null {
  const values = parseFlatNumberList(raw);
  if (values.length < 2) {
    return null;
  }
  return [values[0]!, values[1]!];
}

function parseFlatNumberList(raw: string): number[] {
  return raw
    .split(",")
    .map((value) => Number.parseFloat(value.trim()))
    .filter((value) => Number.isFinite(value));
}

function pairFlatNumbers(values: number[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    pairs.push([values[index]!, values[index + 1]!]);
  }
  return pairs;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function streamAudio(req: IncomingMessage, res: ServerResponse, audioPath: string): void {
  const stat = statSync(audioPath);
  const range = req.headers.range;
  const contentType = audioPath.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav";

  if (!range) {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    });
    createReadStream(audioPath).pipe(res);
    return;
  }

  const parsedRange = parseByteRange(range, stat.size);
  if (!parsedRange) {
    writeRangeNotSatisfiable(res, stat.size);
    return;
  }
  const { start, end } = parsedRange;
  const chunkSize = end - start + 1;

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": contentType
  });
  createReadStream(audioPath, { start, end }).pipe(res);
}
