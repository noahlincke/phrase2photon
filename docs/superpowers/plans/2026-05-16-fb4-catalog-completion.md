# FB4 Catalog Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the FB4 cue catalog to all 1500 cues using raw `.FB4Animation` inventory as source of truth, official packet thumbnails where available, and styled placeholder thumbnails elsewhere.

**Architecture:** Extend the generator to merge two sources: raw pack filenames define the complete `page + cue` inventory and packet sheets provide visual coverage for the subset the PDF actually indexes. The runtime catalog stays keyed by `page + cue`, while generated metadata records whether a cue is packet-backed or placeholder-backed so the UI remains honest and stable.

**Tech Stack:** TypeScript, Node.js scripts, Vite runtime assets, Vitest, `pdftocairo`, `ffmpeg`

---

### Task 1: Lock behavior with failing tests

**Files:**
- Modify: `runtime/src/__tests__/fb4Dmx16.test.ts`

- [ ] Assert the catalog contains exactly `1500` cues with page counts `240/240/240/240/100/100/100/100/100/40`.
- [ ] Assert placeholder-backed cues exist for raw-only ranges such as `P1 C221`.
- [ ] Assert packet-backed cues still exist for known official ranges such as `P2 C1` and `P10 C40`.
- [ ] Assert local description metadata does not replace generated cue identity.

### Task 2: Extend generator/model for full inventory and placeholders

**Files:**
- Modify: `runtime/scripts/generateFb4CueCatalog.ts`
- Modify: `runtime/src/dmx/fb4CueCatalog.types.ts`
- Modify: `runtime/src/dmx/fb4CueCatalog.ts`

- [ ] Add raw-pack inventory discovery from `~/Downloads/FB4_Beam_Content_Pack_1`.
- [ ] Add packet coverage configs for official thumbnail-bearing ranges.
- [ ] Add styled placeholder thumbnail generation for raw-only cues.
- [ ] Generate richer source metadata that distinguishes packet-backed vs placeholder-backed entries.
- [ ] Keep `P1` names stable, generate family-prefixed names for `P2-P4`, and retain existing full-pack naming for `P5-P10`.

### Task 3: Regenerate assets and verify runtime behavior

**Files:**
- Modify: `runtime/src/dmx/fb4CueCatalog.generated.ts`
- Modify: `runtime/public/fb4-thumbnails/*`
- Modify: `runtime/src/app/main.ts`

- [ ] Regenerate the catalog and all thumbnails/placeholders.
- [ ] Migrate the runtime catalog edit handling so handwritten text acts as `description` instead of replacing generated `name`.
- [ ] Run `cd runtime && npm test`.
- [ ] Run `cd runtime && npm run typecheck`.
