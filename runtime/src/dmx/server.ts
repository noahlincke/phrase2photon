import type { IncomingMessage, ServerResponse } from "node:http";

import { sendArtDmx } from "./artnet.js";

export interface DmxFrameRequest {
  enabled: boolean;
  host: string;
  universe: number;
  channels: number[];
  profile: string;
  palette: string;
  source?: "show" | "overlay";
  holdMs?: number;
  holdForever?: boolean;
}

export interface LastDmxFrame {
  enabled: boolean;
  profile: string;
  palette: string;
  host: string;
  universe: number;
  nonZeroChannels: number;
  channels: number[];
  sentAt: string;
  sent: boolean;
  error: string | null;
  refreshSends: number;
}

let lastFrame: LastDmxFrame | null = null;
let overlayHoldUntil = 0;
let overlayHoldForever = false;
let heldLiveFrame: { host: string; universe: number; channels: number[] } | null = null;
let holdRefreshTimer: ReturnType<typeof setInterval> | null = null;
let holdRefreshInFlight = false;
let holdRefreshSends = 0;

const HOLD_REFRESH_INTERVAL_MS = 100;

export async function handleDmxFrame(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = JSON.parse(await readRequestBody(req)) as DmxFrameRequest;
  const now = Date.now();
  if (payload.source === "show" && (overlayHoldForever || now < overlayHoldUntil)) {
    sendJson(res, { ok: true, ignored: true, lastFrame });
    return;
  }

  const channels = normalizeUniverse(payload.channels);
  let sent = false;
  let error: string | null = null;

  if (payload.enabled) {
    try {
      await sendArtDmx({
        host: payload.host,
        universe: payload.universe,
        channels
      });
      sent = true;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  lastFrame = {
    enabled: payload.enabled,
    profile: payload.profile,
    palette: payload.palette,
    host: payload.host,
    universe: payload.universe,
    nonZeroChannels: channels.filter((value) => value > 0).length,
    channels: channels.slice(0, Math.max(16, Math.min(512, payload.channels.length || 16))),
    sentAt: new Date().toISOString(),
    sent,
    error,
    refreshSends: holdRefreshSends
  };

  if (payload.source === "overlay") {
    overlayHoldForever = payload.holdForever === true;
    overlayHoldUntil = overlayHoldForever ? Number.POSITIVE_INFINITY : now + Math.max(0, Math.min(300_000, Math.round(payload.holdMs ?? 0)));
    heldLiveFrame = payload.enabled ? { host: payload.host, universe: payload.universe, channels } : null;
    holdRefreshSends = 0;
    syncHoldRefreshTimer();
  }

  sendJson(res, { ok: error === null, lastFrame });
}

export function handleDmxStatus(res: ServerResponse): void {
  sendJson(res, {
    lastFrame,
    hold: currentHoldState(),
    refreshing: holdRefreshTimer !== null,
    refreshSends: holdRefreshSends
  });
}

export function handleDmxHoldRelease(res: ServerResponse): void {
  overlayHoldForever = false;
  overlayHoldUntil = 0;
  heldLiveFrame = null;
  syncHoldRefreshTimer();
  sendJson(res, { ok: true, lastFrame, hold: "none" });
}

function currentHoldState(): "forever" | "timed" | "none" {
  if (overlayHoldForever) {
    return "forever";
  }
  return overlayHoldUntil > Date.now() ? "timed" : "none";
}

function syncHoldRefreshTimer(): void {
  const shouldRefresh = heldLiveFrame !== null && currentHoldState() !== "none";
  if (!shouldRefresh) {
    if (holdRefreshTimer) {
      clearInterval(holdRefreshTimer);
      holdRefreshTimer = null;
    }
    return;
  }
  if (!holdRefreshTimer) {
    holdRefreshTimer = setInterval(() => {
      void refreshHeldLiveFrame();
    }, HOLD_REFRESH_INTERVAL_MS);
  }
}

async function refreshHeldLiveFrame(): Promise<void> {
  if (!heldLiveFrame || holdRefreshInFlight) {
    return;
  }
  if (currentHoldState() === "none") {
    heldLiveFrame = null;
    syncHoldRefreshTimer();
    return;
  }

  holdRefreshInFlight = true;
  try {
    await sendArtDmx(heldLiveFrame);
    holdRefreshSends += 1;
    if (lastFrame) {
      lastFrame = {
        ...lastFrame,
        sent: true,
        error: null,
        sentAt: new Date().toISOString(),
        refreshSends: holdRefreshSends
      };
    }
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    if (lastFrame) {
      lastFrame = {
        ...lastFrame,
        sent: false,
        error,
        refreshSends: holdRefreshSends
      };
    }
  } finally {
    holdRefreshInFlight = false;
  }
}

function normalizeUniverse(channels: number[]): number[] {
  const output = new Array<number>(512).fill(0);
  channels.slice(0, 512).forEach((value, index) => {
    output[index] = Math.max(0, Math.min(255, Math.round(value)));
  });
  return output;
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

function sendJson(res: ServerResponse, payload: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}
