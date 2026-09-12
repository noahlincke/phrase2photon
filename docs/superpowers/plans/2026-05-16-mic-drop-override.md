# Mic Drop Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Mic mode jump early into `Drop` when a strong bass change lands near a bar start, and make BPM detection more bass-led so bar alignment is stable enough to trust.

**Architecture:** Keep all behavior inside `runtime/src/app/liveMicInput.ts`, where Mic mode already owns band history, BPM estimation, phrase selection, and phrase event ids. Add a small set of pure helper functions for bass-led onset scoring, bar-start alignment, and early-drop override eligibility, then thread those helpers through `snapshot()` so the render loop keeps consuming the same shape.

**Tech Stack:** TypeScript, Vitest, Vite runtime UI, browser Web Audio analyser data

---

### Task 1: Add failing tests for bass-led drop override helpers

**Files:**
- Modify: `runtime/src/__tests__/liveMicInput.test.ts`
- Test: `runtime/src/__tests__/liveMicInput.test.ts`

- [ ] **Step 1: Write the failing helper tests**

```ts
import {
  phraseIndexForProfile,
  shouldForceDropNearBarStart,
  summarizeBands
} from "../app/liveMicInput.js";

it("forces drop when a strong low-end surge lands near a bar start", () => {
  const history = [
    { low: 0.18, mid: 0.12, high: 0.08 },
    { low: 0.2, mid: 0.14, high: 0.08 },
    { low: 0.22, mid: 0.14, high: 0.09 },
    { low: 0.78, mid: 0.28, high: 0.12 }
  ];

  expect(shouldForceDropNearBarStart({
    history,
    profile: summarizeBands(history),
    phraseIndex: 2,
    beatPhase: 0.04,
    beatInBar: 1,
    lastForcedDropBar: null,
    currentBar: 17
  })).toBe(true);
});

it("does not force drop away from the bar-start alignment window", () => {
  const history = [
    { low: 0.18, mid: 0.12, high: 0.08 },
    { low: 0.2, mid: 0.14, high: 0.08 },
    { low: 0.22, mid: 0.14, high: 0.09 },
    { low: 0.78, mid: 0.28, high: 0.12 }
  ];

  expect(shouldForceDropNearBarStart({
    history,
    profile: summarizeBands(history),
    phraseIndex: 2,
    beatPhase: 0.42,
    beatInBar: 2,
    lastForcedDropBar: null,
    currentBar: 17
  })).toBe(false);
});

it("keeps loud balanced material out of drop without the bass surge signature", () => {
  expect(phraseIndexForProfile({
    averageLow: 0.36,
    averageMid: 0.38,
    averageHigh: 0.24,
    peakLow: 0.55,
    peakLevel: 0.64,
    sustainedLevel: 0.42
  }, 2)).toBe(2);
});
```

- [ ] **Step 2: Run the focused test command and verify it fails**

```bash
cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts
```

Expected: FAIL because `shouldForceDropNearBarStart` does not exist yet.

- [ ] **Step 3: Add minimal helper exports in `liveMicInput.ts`**

```ts
export interface DropOverrideInput {
  history: AudioBands[];
  profile: LiveMicBandProfile;
  phraseIndex: number;
  beatPhase: number;
  beatInBar: number;
  lastForcedDropBar: number | null;
  currentBar: number;
}

export function shouldForceDropNearBarStart(input: DropOverrideInput): boolean {
  const nearBarStart = input.beatInBar === 1 && (input.beatPhase <= 0.14 || input.beatPhase >= 0.86);
  if (!nearBarStart || input.phraseIndex === 3 || input.lastForcedDropBar === input.currentBar) {
    return false;
  }
  const recent = input.history.slice(-4);
  const currentLow = recent[recent.length - 1]?.low ?? 0;
  const baselineLow = recent.slice(0, -1).reduce((sum, band) => sum + band.low, 0) / Math.max(1, recent.length - 1);
  const lowDelta = currentLow - baselineLow;
  return currentLow > 0.58 && lowDelta > 0.2 && input.profile.sustainedLevel > 0.24;
}
```

- [ ] **Step 4: Re-run the focused test command and verify the helper tests pass**

```bash
cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts
```

Expected: PASS for the new helper tests, with no import/runtime errors.

### Task 2: Add failing tests for live snapshot early-drop event behavior

**Files:**
- Modify: `runtime/src/__tests__/liveMicInput.test.ts`
- Modify: `runtime/src/app/liveMicInput.ts`

- [ ] **Step 1: Write the failing snapshot tests**

```ts
it("emits a fresh drop phrase event early when the bass surge hits near a bar start", () => {
  const liveMic = new LiveMicInput();
  vi.spyOn(liveMic.analyser, "snapshot")
    .mockReturnValueOnce({ low: 0.2, mid: 0.14, high: 0.08 })
    .mockReturnValueOnce({ low: 0.22, mid: 0.14, high: 0.08 })
    .mockReturnValueOnce({ low: 0.78, mid: 0.28, high: 0.12 });

  (liveMic as any).startedAtSeconds = 0;
  (liveMic as any).estimatedBpm = 120;

  liveMic.snapshot(15_500);
  liveMic.snapshot(15_900);
  const snapshot = liveMic.snapshot(16_020);

  expect(snapshot.playback.active.phrase.name).toBe("Drop");
  expect(snapshot.phraseEventId).toContain("drop");
});

it("does not keep emitting fresh drop events for the same bar-start opportunity", () => {
  const liveMic = new LiveMicInput();
  vi.spyOn(liveMic.analyser, "snapshot").mockReturnValue({ low: 0.8, mid: 0.28, high: 0.12 });

  (liveMic as any).startedAtSeconds = 0;
  (liveMic as any).estimatedBpm = 120;
  (liveMic as any).bandHistory.push(
    { low: 0.18, mid: 0.12, high: 0.08 },
    { low: 0.2, mid: 0.14, high: 0.08 },
    { low: 0.22, mid: 0.14, high: 0.09 }
  );

  const first = liveMic.snapshot(16_020);
  const second = liveMic.snapshot(16_060);

  expect(first.phraseEventId).toBe(second.phraseEventId);
});
```

- [ ] **Step 2: Run the focused test command and verify it fails on the old snapshot flow**

```bash
cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts
```

Expected: FAIL because `snapshot()` only changes phrase state on 32-beat slot boundaries.

- [ ] **Step 3: Implement the early-drop override inside `snapshot()`**

```ts
private lastForcedDropBar: number | null = null;
private forcedPhraseEventId: string | null = null;

const beatInBar = (Math.floor(beatFloat) % 4) + 1;
const currentBar = Math.floor(beatFloat / 4) + 1;
const profile = summarizeBands(this.bandHistory);
const slotPhraseIndex = slot !== this.phraseSlot
  ? phraseIndexForProfile(profile, slot)
  : this.activePhraseIndex;

const forceDrop = shouldForceDropNearBarStart({
  history: this.bandHistory,
  profile,
  phraseIndex: slotPhraseIndex,
  beatPhase: beatFloat - Math.floor(beatFloat),
  beatInBar,
  lastForcedDropBar: this.lastForcedDropBar,
  currentBar
});

if (forceDrop) {
  this.activePhraseIndex = 3;
  this.lastForcedDropBar = currentBar;
  this.forcedPhraseEventId = `mic_drop_bar_${currentBar}`;
  this.status = `Phrase ${slot + 1}: Drop`;
}
```

- [ ] **Step 4: Re-run the focused test command and verify the snapshot tests pass**

```bash
cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts
```

Expected: PASS for the new early-drop event tests, with no regression in the existing phrase-classification tests.

### Task 3: Add failing tests for bass-led onset scoring and implement BPM weighting changes

**Files:**
- Modify: `runtime/src/__tests__/liveMicInput.test.ts`
- Modify: `runtime/src/app/liveMicInput.ts`

- [ ] **Step 1: Write the failing onset-weighting tests**

```ts
import { onsetLevelForBands } from "../app/liveMicInput.js";

it("weights kick-like low-end pulses more strongly than balanced broadband spikes", () => {
  const kick = onsetLevelForBands({ low: 0.72, mid: 0.2, high: 0.08 }, { low: 0.22, mid: 0.16, high: 0.08 });
  const broad = onsetLevelForBands({ low: 0.34, mid: 0.34, high: 0.3 }, { low: 0.18, mid: 0.18, high: 0.18 });

  expect(kick).toBeGreaterThan(broad);
  expect(kick).toBeGreaterThan(0.45);
});
```

- [ ] **Step 2: Run the focused test command and verify it fails**

```bash
cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts
```

Expected: FAIL because `onsetLevelForBands` does not exist and tempo updates still use `weightedLevel()` only.

- [ ] **Step 3: Implement bass-led onset scoring and use it in `updateTempo()`**

```ts
export function onsetLevelForBands(current: AudioBands, previous: AudioBands | null): number {
  const lowDelta = Math.max(0, current.low - (previous?.low ?? current.low));
  const midDelta = Math.max(0, current.mid - (previous?.mid ?? current.mid));
  const highDelta = Math.max(0, current.high - (previous?.high ?? current.high));
  return Math.max(
    0,
    Math.min(1, current.low * 0.45 + lowDelta * 0.35 + current.mid * 0.12 + midDelta * 0.05 + current.high * 0.03 + highDelta * 0.02)
  );
}

const previousBands = this.bandHistory[this.bandHistory.length - 2] ?? null;
const onsetLevel = onsetLevelForBands(bands, previousBands);
this.updateTempo(onsetLevel, nowSeconds);
```

- [ ] **Step 4: Re-run the focused test command and verify the onset tests pass**

```bash
cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts
```

Expected: PASS, with the new onset helper preferring kick-like low-end pulses.

### Task 4: Full verification

**Files:**
- Verify: `runtime/src/__tests__/liveMicInput.test.ts`
- Verify: `runtime/src/app/liveMicInput.ts`
- Verify: `runtime/package.json`

- [ ] **Step 1: Run the focused mic test file**

```bash
cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts
```

Expected: PASS for all live mic tests.

- [ ] **Step 2: Run the full runtime unit test suite**

```bash
cd /Users/nlincke/phrase2photon/runtime && npm test
```

Expected: PASS with 0 failures.

- [ ] **Step 3: Run the runtime typecheck**

```bash
cd /Users/nlincke/phrase2photon/runtime && npm run typecheck
```

Expected: PASS with no TypeScript errors.
