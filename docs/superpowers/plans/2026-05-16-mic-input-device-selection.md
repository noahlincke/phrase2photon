# Mic Input Device Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared left-sidebar mic-input dropdown that prefers Loopback-like devices by default and drives both Mic mode and Now Playing's reactive fallback.

**Architecture:** Keep device-preference logic in a small pure helper module so the selection rules are testable without browser APIs. Extend the live mic input wrapper to accept an optional selected device id, then wire sidebar state in `runtime/src/app/main.ts` so Mic mode and Now Playing fallback both use the same selection and persistence rules.

**Tech Stack:** TypeScript, Vitest, Vite runtime UI, browser media devices API

---

### Task 1: Device preference helper

**Files:**
- Create: `runtime/src/app/micInputDevices.ts`
- Create: `runtime/src/__tests__/micInputDevices.test.ts`

- [ ] Add failing tests for Loopback-like default preference, explicit saved-device preservation, and fallback when the saved device disappears.
- [ ] Run `npm test -- --run runtime/src/__tests__/micInputDevices.test.ts` from `runtime/` and confirm the new tests fail for the missing helper.
- [ ] Implement the pure device-selection helper with Loopback-like label matching and option-label fallback.
- [ ] Re-run `npm test -- --run runtime/src/__tests__/micInputDevices.test.ts` from `runtime/` and confirm the helper tests pass.

### Task 2: Live mic device-aware startup

**Files:**
- Modify: `runtime/src/app/liveMicInput.ts`
- Modify: `runtime/src/__tests__/liveMicInput.test.ts`

- [ ] Add a failing test that verifies `LiveMicInput.start()` passes the selected device id into `getUserMedia`, while still using browser-default audio when no device id is selected.
- [ ] Run `npm test -- --run runtime/src/__tests__/liveMicInput.test.ts` from `runtime/` and confirm the new test fails for the old start signature.
- [ ] Implement a device-aware `start()` path and expose enough state for the sidebar to know which device is active.
- [ ] Re-run `npm test -- --run runtime/src/__tests__/liveMicInput.test.ts` from `runtime/` and confirm the mic tests pass.

### Task 3: Sidebar wiring and shared fallback behavior

**Files:**
- Modify: `runtime/src/app/main.ts`
- Modify: `runtime/src/app/styles.css`

- [ ] Add the shared sidebar dropdown, device refresh logic, persistence, and live restart behavior when the user changes inputs while mic capture is running.
- [ ] Route Now Playing fallback startup through the same selected device id used by Mic mode.
- [ ] Verify the runtime still renders the correct mode surfaces for Library, Mic, and Now Playing after the UI wiring lands.

### Task 4: Verification

**Files:**
- Verify: `runtime/src/__tests__/micInputDevices.test.ts`
- Verify: `runtime/src/__tests__/liveMicInput.test.ts`
- Verify: `runtime/package.json`

- [ ] Run `npm test -- --run runtime/src/__tests__/micInputDevices.test.ts runtime/src/__tests__/liveMicInput.test.ts` from `runtime/`.
- [ ] Run `npm test` from `runtime/`.
- [ ] Run `npm run typecheck` from `runtime/`.
