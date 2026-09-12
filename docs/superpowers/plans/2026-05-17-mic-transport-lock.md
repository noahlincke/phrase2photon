# Mic Transport Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fixed-BPM and beat-1 tap controls to Mic mode so the operator can lock tempo and manually re-anchor downbeat phase.

**Architecture:** Keep timing ownership inside `runtime/src/app/liveMicInput.ts`, where the mic producer already owns BPM estimation and beat/bar phase. Extend `runtime/src/app/main.ts` only to render the controls and forward user intent into new producer methods, then add narrow browser coverage for the new UI state.

**Tech Stack:** TypeScript, Vitest, Playwright, Vite runtime UI, browser Web Audio analyser data

---

### Task 1: Add failing `LiveMicInput` tests for fixed BPM and beat-1 tapping

**Files:**
- Modify: `runtime/src/__tests__/liveMicInput.test.ts`
- Test: `runtime/src/__tests__/liveMicInput.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("holds a fixed bpm even when later onsets suggest a different tempo", () => {
  const liveMic = new LiveMicInput();
  liveMic.setFixedBpm(128);
  vi.spyOn(liveMic.analyser, "snapshot").mockReturnValue({ low: 0.8, mid: 0.22, high: 0.08 });

  const state = liveMic as any;
  state.startedAtSeconds = 0;
  state.onsetTimes.push(1, 1.5, 2);
  state.levels.push(0.04, 0.05, 0.06);
  state.bandHistory.push({ low: 0.12, mid: 0.08, high: 0.04 });

  const snapshot = liveMic.snapshot(2_500);

  expect(snapshot.bpm).toBe(128);
});

it("returns to mic tempo detection after fixed bpm is released", () => {
  const liveMic = new LiveMicInput();
  liveMic.setFixedBpm(128);
  liveMic.clearFixedBpm();
  vi.spyOn(liveMic.analyser, "snapshot").mockReturnValue({ low: 0.8, mid: 0.22, high: 0.08 });

  const state = liveMic as any;
  state.startedAtSeconds = 0;
  state.estimatedBpm = 128;
  state.onsetTimes.push(1, 1.5, 2);
  state.levels.push(0.04, 0.05, 0.06);
  state.bandHistory.push({ low: 0.12, mid: 0.08, high: 0.04 });

  const snapshot = liveMic.snapshot(2_500);

  expect(snapshot.bpm).toBe(120);
});

it("re-anchors beat 1 without changing the current bpm", () => {
  const liveMic = new LiveMicInput();
  liveMic.setFixedBpm(128);
  vi.spyOn(liveMic.analyser, "snapshot").mockReturnValue({ low: 0.1, mid: 0.08, high: 0.05 });

  liveMic.tapBeatOne(4_500);
  const snapshot = liveMic.snapshot(4_500);

  expect(snapshot.bpm).toBe(128);
  expect(snapshot.playback.beat).toBe(1);
  expect(snapshot.playback.bar).toBe(1);
});
```

- [ ] **Step 2: Run the focused test file and verify the new tests fail**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts`

Expected: FAIL because `setFixedBpm`, `clearFixedBpm`, and `tapBeatOne` do not exist yet.

- [ ] **Step 3: Implement the minimal `LiveMicInput` transport-control API**

```ts
private fixedBpm: number | null = null;

get hasFixedBpm(): boolean {
  return this.fixedBpm !== null;
}

get fixedBpmValue(): number | null {
  return this.fixedBpm;
}

setFixedBpm(bpm: number): void {
  this.fixedBpm = clampMicBpm(bpm);
  this.estimatedBpm = this.fixedBpm;
  this.resetTempoDetectionState();
}

clearFixedBpm(): void {
  this.fixedBpm = null;
  this.resetTempoDetectionState();
}

tapBeatOne(nowMs: number): void {
  this.startedAtSeconds = nowMs / 1000;
  this.phraseSlot = -1;
  this.activePhraseIndex = 0;
  this.lastForcedDropBar = null;
}
```

- [ ] **Step 4: Gate tempo updates on the fixed BPM lock**

```ts
if (this.fixedBpm !== null) {
  this.estimatedBpm = this.fixedBpm;
} else {
  this.updateTempo(onsetLevelForBands(bands, previousBands), nowSeconds);
}
```

- [ ] **Step 5: Re-run the focused test file and verify the new tests pass**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts`

Expected: PASS for the new transport-lock tests and the existing mic tests.

### Task 2: Add failing browser coverage for the mic transport controls

**Files:**
- Modify: `runtime/e2e/runtime.spec.ts`
- Test: `runtime/e2e/runtime.spec.ts`

- [ ] **Step 1: Write the failing browser test**

```ts
test("exposes fixed bpm and beat-1 tap controls in mic mode", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Mic input" }).click();
  await expect(page.getByLabel("Fixed BPM")).toBeVisible();
  await expect(page.getByLabel("Fixed BPM value")).toBeDisabled();
  await page.getByLabel("Fixed BPM").check();
  await expect(page.getByLabel("Fixed BPM value")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Tap Beat 1" })).toBeVisible();
});
```

- [ ] **Step 2: Run the focused Playwright test and verify it fails for the missing controls**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm run e2e -- --grep "fixed bpm and beat-1 tap controls"`

Expected: FAIL because the checkbox, numeric input, and tap button are not in the DOM yet.

- [ ] **Step 3: Add the minimal mic-control UI in `main.ts` and styling in `styles.css`**

```ts
<label class="toggle-row">
  <input id="micFixedBpmEnabled" type="checkbox" aria-label="Fixed BPM" />
  <span>Fixed BPM</span>
</label>
<label class="field-row">
  <span>Fixed BPM value</span>
  <input id="micFixedBpmValue" type="number" min="80" max="170" step="1" aria-label="Fixed BPM value" disabled />
</label>
<button id="micTapBeatOne" class="secondary-button" type="button">Tap Beat 1</button>
```

- [ ] **Step 4: Wire the new controls into `LiveMicInput`**

```ts
elements.micFixedBpmEnabled.addEventListener("change", () => {
  if (elements.micFixedBpmEnabled.checked) {
    liveMic.setFixedBpm(Number(elements.micFixedBpmValue.value));
  } else {
    liveMic.clearFixedBpm();
  }
  renderMicTransportControls();
});

elements.micFixedBpmValue.addEventListener("change", () => {
  if (elements.micFixedBpmEnabled.checked) {
    liveMic.setFixedBpm(Number(elements.micFixedBpmValue.value));
  }
});

elements.micTapBeatOne.addEventListener("click", () => {
  liveMic.tapBeatOne(performance.now());
});
```

- [ ] **Step 5: Re-run the focused Playwright test and verify it passes**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm run e2e -- --grep "fixed bpm and beat-1 tap controls"`

Expected: PASS with the numeric BPM input disabled until the checkbox is checked.

### Task 3: Full verification

**Files:**
- Verify: `runtime/src/__tests__/liveMicInput.test.ts`
- Verify: `runtime/e2e/runtime.spec.ts`
- Verify: `runtime/package.json`

- [ ] **Step 1: Run the focused mic unit tests**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- --run src/__tests__/liveMicInput.test.ts`

Expected: PASS.

- [ ] **Step 2: Run the full unit test suite**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test`

Expected: PASS with 0 failures.

- [ ] **Step 3: Run the runtime typecheck**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Run the full Playwright suite**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm run e2e`

Expected: PASS with the new mic transport control coverage included.
