import { describe, expect, it } from "vitest";

import {
  fitTimelineLabel,
  inferPhraseKind,
  timelineLabelText,
  type TimelinePhrase
} from "../app/audioTimeline.js";

function phraseWith(name: string, kind: TimelinePhrase["kind"]): TimelinePhrase {
  return { phraseId: "p1", name, kind, startSeconds: 0, endSeconds: 10 };
}

describe("inferPhraseKind", () => {
  it("reads the arrangement name first", () => {
    expect(inferPhraseKind("Intro", "mid")).toBe("intro");
    expect(inferPhraseKind("Outro", "mid")).toBe("outro");
    expect(inferPhraseKind("Stripped ", "mid")).toBe("breakdown");
    expect(inferPhraseKind("Bass In", "low")).toBe("breakdown");
    expect(inferPhraseKind("Riser 2", "high")).toBe("build");
    expect(inferPhraseKind("Drop Teaser", "high")).toBe("drop");
  });

  it("falls back to energy when the name says nothing", () => {
    expect(inferPhraseKind("24", "peak")).toBe("drop");
    expect(inferPhraseKind("24", "low")).toBe("breakdown");
    expect(inferPhraseKind("24", "mid")).toBe("groove");
    expect(inferPhraseKind("24", "high")).toBe("groove");
  });
});

describe("timelineLabelText", () => {
  it("keeps names that carry words", () => {
    expect(timelineLabelText(phraseWith("Bass In", "groove"))).toBe("Bass In");
  });

  it("replaces bare bar numbers with the kind name", () => {
    expect(timelineLabelText(phraseWith("24", "groove"))).toBe("Groove");
    expect(timelineLabelText(phraseWith("  ", "drop"))).toBe("Drop");
  });
});

describe("fitTimelineLabel", () => {
  const measure = (text: string): number => text.length * 10;

  it("keeps a label that fits", () => {
    expect(fitTimelineLabel("Drop A", 60, measure)).toBe("Drop A");
  });

  it("trims instead of squeezing a label that does not fit", () => {
    expect(fitTimelineLabel("Drop A", 45, measure)).toBe("Drop");
  });

  it("gives up when even one character does not fit", () => {
    expect(fitTimelineLabel("Drop A", 5, measure)).toBeNull();
  });
});
