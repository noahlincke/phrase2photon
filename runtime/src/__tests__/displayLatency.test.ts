import { describe, expect, it } from "vitest";
import {
  DISPLAY_LATENCY_KEY,
  DISPLAY_LATENCY_MAX_MS,
  displayPlaybackSeconds,
  parseDisplayLatencyMs
} from "../app/displayLatency.js";

describe("display latency", () => {
  it("evaluates the visual frame ahead by the offset", () => {
    expect(displayPlaybackSeconds(10, 500)).toBe(10.5);
    expect(displayPlaybackSeconds(10, DISPLAY_LATENCY_MAX_MS)).toBe(12.5);
    expect(displayPlaybackSeconds(0, 5)).toBe(0.005);
  });

  it("evaluates at playback time when no show clock exists", () => {
    // Live mic cannot predict the future, so the graphics offset is inactive.
    expect(displayPlaybackSeconds(10, null)).toBe(10);
  });

  it("keeps the graphics setting separate from the laser's output latency", () => {
    expect(DISPLAY_LATENCY_KEY).not.toBe("p2p.dmx.latencyMs");
  });

  it("parses and clamps the persisted setting", () => {
    expect(parseDisplayLatencyMs("845")).toBe(845);
    expect(parseDisplayLatencyMs("-5")).toBe(0);
    expect(parseDisplayLatencyMs(String(DISPLAY_LATENCY_MAX_MS + 500))).toBe(DISPLAY_LATENCY_MAX_MS);
    expect(parseDisplayLatencyMs("nope")).toBe(0);
    expect(parseDisplayLatencyMs(null)).toBe(0);
  });
});
