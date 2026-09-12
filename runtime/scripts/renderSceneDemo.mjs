import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const outputDir = resolve(runtimeRoot, args.outdir);
const tempDir = resolve(outputDir, ".tmp");
const baseUrl = `http://127.0.0.1:${args.port}`;
const captureUrl = `${baseUrl}/?export=1`;

let serverProcess = null;
try {
  await mkdir(outputDir, { recursive: true });
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  if (!(await endpointReady(`${baseUrl}/api/library`, 1000))) {
    serverProcess = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(args.port)], {
      cwd: runtimeRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    serverProcess.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    serverProcess.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    const ready = await endpointReady(`${baseUrl}/api/library`, 20000);
    if (!ready) {
      throw new Error(`Timed out waiting for runtime dev server at ${baseUrl}`);
    }
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-frame-rate-limit",
      "--disable-renderer-backgrounding"
    ]
  });
  const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
  await page.goto(captureUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    return typeof window.__PHRASE2PHOTON_DEBUG__?.loadTrackById === "function";
  });
  await page.waitForFunction(async () => {
    const scenes = window.__PHRASE2PHOTON_DEBUG__?.listScenes() ?? [];
    return scenes.length > 0;
  }, {}, { timeout: 15000 }).catch(() => undefined);

  const loaded = await retryInPage(page, args.track, async (trackId) => {
    return await window.__PHRASE2PHOTON_DEBUG__?.loadTrackById(trackId);
  });
  if (!loaded) {
    throw new Error(`Unable to load track ${args.track} through debug API.`);
  }

  await page.waitForTimeout(1200);

  const presetList = (await page.evaluate(() => window.__PHRASE2PHOTON_DEBUG__?.listScenes() ?? []))
    .map((scene) => ({ presetId: scene.id, name: scene.name }));
  if (!presetList.length) {
    throw new Error("Runtime did not expose any scenes after track load.");
  }

  const appliedRenderScale = await page.evaluate((scale) => {
    return window.__PHRASE2PHOTON_DEBUG__?.setRenderScale(scale) ?? 1;
  }, args.renderScale);

  const selectedPresetIds = (args.presetIds.length
    ? args.presetIds
    : presetList.slice(0, args.count).map((entry) => entry.presetId)
  ).filter((presetId) => presetList.some((entry) => entry.presetId === presetId));
  if (!selectedPresetIds.length) {
    throw new Error("No preset ids matched the available runtime preset catalog.");
  }
  const manifest = buildManifest(selectedPresetIds, args.track, args.baseStart, args.duration);
  manifest.capture = {
    width: args.width,
    height: args.height,
    fps: args.fps,
    renderScale: appliedRenderScale,
    exportMode: true
  };

  for (const entry of manifest.entries) {
    const webmPath = resolve(tempDir, entry.filename.replace(/\.mp4$/i, ".webm"));
    const mp4Path = resolve(outputDir, entry.filename);

    process.stdout.write(`Rendering ${entry.filename}\n`);
    const bytes = await page.evaluate(recordPresetDemoInPage, {
      presetId: entry.presetId,
      startSeconds: entry.startSeconds,
      durationSeconds: entry.durationSeconds,
      fps: args.fps
    });
    await writeFile(webmPath, Buffer.from(bytes));

    await runCommand("ffmpeg", [
      "-y",
      "-loglevel", "error",
      "-stats",
      "-fflags", "+discardcorrupt",
      "-err_detect", "ignore_err",
      "-i", webmPath,
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-shortest",
      mp4Path
    ]);
    await verifyRenderedVideo(
      mp4Path,
      entry.durationSeconds,
      expectedVideoDimension(args.width, appliedRenderScale),
      expectedVideoDimension(args.height, appliedRenderScale)
    );
    await rm(webmPath, { force: true });
  }

  await writeFile(resolve(outputDir, "demo-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(tempDir, { recursive: true, force: true });
  await browser.close();
} finally {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
  }
}

function parseArgs(argv) {
  const values = {
    track: "kolter-let-you-go",
    duration: 10,
    count: 32,
    port: 4173,
    baseStart: 37,
    outdir: "rendered-demos",
    renderScale: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    presetIds: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--track" && next) {
      values.track = next;
      index += 1;
    } else if (arg === "--duration" && next) {
      values.duration = Number(next);
      index += 1;
    } else if (arg === "--count" && next) {
      values.count = Number(next);
      index += 1;
    } else if (arg === "--port" && next) {
      values.port = Number(next);
      index += 1;
    } else if (arg === "--base-start" && next) {
      values.baseStart = Number(next);
      index += 1;
    } else if (arg === "--outdir" && next) {
      values.outdir = next;
      index += 1;
    } else if (arg === "--render-scale" && next) {
      values.renderScale = Number(next);
      index += 1;
    } else if (arg === "--width" && next) {
      values.width = Number(next);
      index += 1;
    } else if (arg === "--height" && next) {
      values.height = Number(next);
      index += 1;
    } else if (arg === "--fps" && next) {
      values.fps = Number(next);
      index += 1;
    } else if (arg === "--preset-id" && next) {
      values.presetIds.push(next);
      index += 1;
    }
  }

  return values;
}

function buildManifest(presetIds, trackId, baseStartSeconds, durationSeconds) {
  return {
    version: 1,
    entries: presetIds.map((presetId, index) => ({
      order: index + 1,
      presetId,
      trackId,
      startSeconds: chooseStartSeconds(baseStartSeconds, presetId, index),
      durationSeconds,
      filename: `${String(index + 1).padStart(2, "0")}-${presetId}-${trackId}.mp4`
    }))
  };
}

function chooseStartSeconds(baseStartSeconds, presetId, index) {
  if (presetId.includes("drop") || presetId.includes("chop") || presetId.includes("strike")) {
    return baseStartSeconds + 60;
  }
  if (presetId.includes("calm") || presetId.includes("mist") || presetId.includes("sanctum")) {
    return Math.max(0, baseStartSeconds - 20);
  }
  return baseStartSeconds + (index % 4) * 8;
}

async function endpointReady(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return false;
}

async function runCommand(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: runtimeRoot, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} exited with code ${code}`));
      }
    });
    child.on("error", rejectPromise);
  });
}

async function retryInPage(page, value, callback, attempts = 20, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await page.evaluate(callback, value);
    if (result) {
      return result;
    }
    await page.waitForTimeout(delayMs);
  }
  return null;
}

async function verifyRenderedVideo(filePath, expectedDurationSeconds, expectedWidth, expectedHeight) {
  const probe = await runCommandWithOutput("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,duration",
    "-of", "json",
    filePath
  ]);
  const payload = JSON.parse(probe);
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  const audio = payload.streams?.find((stream) => stream.codec_type === "audio");
  if (!video || !audio) {
    throw new Error(`Rendered file ${filePath} is missing a video or audio stream.`);
  }
  if (video.width !== expectedWidth || video.height !== expectedHeight) {
    throw new Error(
      `Rendered file ${filePath} expected ${expectedWidth}x${expectedHeight} but got ${video.width}x${video.height}.`
    );
  }
  const duration = Number(video.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - expectedDurationSeconds) > 0.6) {
    throw new Error(
      `Rendered file ${filePath} expected duration near ${expectedDurationSeconds}s but got ${video.duration}.`
    );
  }
}

function expectedVideoDimension(size, renderScale) {
  const scaled = Math.max(1, Math.floor(size * renderScale));
  return Math.max(2, scaled - (scaled % 2));
}

async function runCommandWithOutput(command, args) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: runtimeRoot, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(new Error(`${command} exited with code ${code}`));
      }
    });
    child.on("error", rejectPromise);
  });
}

async function recordPresetDemoInPage({ presetId, startSeconds, durationSeconds, fps }) {
  const debug = window.__PHRASE2PHOTON_DEBUG__;
  if (!debug) {
    throw new Error("Debug API is unavailable.");
  }

  debug.followTrack(true);
  debug.seekToSeconds(startSeconds);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  if (!debug.setScene(presetId)) {
    throw new Error(`Could not hold scene ${presetId}.`);
  }

  const canvas = document.querySelector("#visualizer");
  const audio = document.querySelector("#audio");
  if (!(canvas instanceof HTMLCanvasElement) || !(audio instanceof HTMLAudioElement)) {
    throw new Error("Runtime media elements are unavailable.");
  }

  const canvasStream = canvas.captureStream(fps);
  const audioStream = audio.captureStream ? audio.captureStream() : audio.mozCaptureStream?.();
  const mixed = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...(audioStream ? audioStream.getAudioTracks() : [])
  ]);

  const chunks = [];
  const recorder = new MediaRecorder(mixed, { mimeType: "video/webm;codecs=vp8,opus" });
  recorder.ondataavailable = (event) => {
    if (event.data.size) {
      chunks.push(event.data);
    }
  };

  const recorded = new Promise((resolvePromise, rejectPromise) => {
    recorder.onerror = () => rejectPromise(new Error("MediaRecorder failed."));
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const buffer = await blob.arrayBuffer();
      resolvePromise(Array.from(new Uint8Array(buffer)));
    };
  });

  await debug.play();
  recorder.start(250);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, durationSeconds * 1000 + 250));
  debug.pause();
  recorder.stop();
  return await recorded;
}
