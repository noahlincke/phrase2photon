import { describe, expect, it } from "vitest";

import { summarizeRekordboxMixer } from "../library/rekordboxMixer.js";

describe("Rekordbox mixer summarization", () => {
  it("keeps only likely vertical line faders and reports the highest value", () => {
    const snapshot = summarizeRekordboxMixer([
      { value: 0.72, x: 100, y: 500, width: 18, height: 140 },
      { value: 0, x: 140, y: 500, width: 18, height: 140 },
      { value: 0.35, x: 180, y: 500, width: 18, height: 140 },
      { value: 0.5, x: 300, y: 120, width: 30, height: 22 }
    ], "2026-05-16T22:30:00.000Z");

    expect(snapshot.lineFaders).toEqual([0.72, 0, 0.35]);
    expect(snapshot.highestLineFader).toBeCloseTo(0.72, 5);
    expect(snapshot.observedAt).toBe("2026-05-16T22:30:00.000Z");
  });

  it("returns null when it cannot positively identify line faders", () => {
    const snapshot = summarizeRekordboxMixer([
      { value: 0.4, x: 100, y: 110, width: 28, height: 20 },
      { value: 0.5, x: 140, y: 110, width: 28, height: 20 }
    ], "2026-05-16T22:31:00.000Z");

    expect(snapshot.lineFaders).toEqual([]);
    expect(snapshot.highestLineFader).toBeNull();
  });
});
