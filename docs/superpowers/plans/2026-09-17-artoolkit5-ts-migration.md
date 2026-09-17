# artoolkit5-ts Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the artoolkit5-js detection engine with artoolkit5-ts 0.2.0, align the plugin's event payloads with AR.js-next's documented contract, and give the repository a single canonical agent instruction file.

**Architecture:** Detection logic moves out of the Web Worker into a DOM-free detector core (`src/detector/artoolkit-detector.js`) that takes RGBA pixels and returns poses. The worker becomes a message pump that converts `ImageBitmap` to pixels and relays results. `plugin.js` keeps lifecycle, the marker registry and event emission, but the registry becomes family-aware and the payloads are renamed.

**Tech Stack:** JavaScript ESM, Vite 7 (library build + worker bundling), Vitest 4 with jsdom, `@ar-js-org/artoolkit5-ts` 0.2.0, prettier, husky.

**Spec:** [docs/superpowers/specs/2026-09-17-artoolkit5-ts-migration-design.md](../specs/2026-09-17-artoolkit5-ts-migration-design.md)

## Global Constraints

- Node `v22.21.1`, pinned in `.nvmrc`. `npm test` will not run on another version.
- Dependency: `@ar-js-org/artoolkit5-ts` at `^0.2.0`. Remove `@ar-js-org/artoolkit5-js` entirely.
- ESM only. `package.json` declares `"type": "module"`; no CommonJS, no `require`.
- Event payload field names are exactly `markerId`, `type`, `matrix`, `confidence`, `timestamp`. Never `id`, never `poseMatrix`.
- Marker registry keys are the template string `` `${type}:${id}` `` — for example `"pattern:3"`.
- `type` is exactly `"pattern"` or `"barcode"`, matching artoolkit5-ts's `MarkerType`.
- `ar:getMarker` must not be emitted anywhere after Task 5.
- Public functions and classes carry JSDoc. Match the density already in `src/plugin.js`.
- Run `npm run format` before every commit; CI checks formatting.
- Conventional commit prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.
- **Never pass `--author` or `-c user.name=…` to `git commit`.** Let the repository's git config decide authorship.
- End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Coverage thresholds after Task 9: lines 75, statements 75, functions 75, branches 50.

### Deliberate refinement of the spec

The spec sketches `createDetector(...) -> Promise<Detector>` while also requiring that state creation defer until real frame dimensions are known. Those cannot both hold, because `createARToolKitState(width, height, …)` needs the dimensions up front. This plan resolves it:

```js
createDetector({ cameraParametersUrl, wasmUrl, minConfidence })  // synchronous
detector.ensureReady(width, height)  -> Promise<boolean>         // creates state, with backoff
detector.loadPattern(patternUrl, size) -> Promise<number>        // awaits readiness internally
detector.detect(pixels)              -> { detected, lost }
detector.dispose()                   -> void
```

Dimensions move from construction to `ensureReady`, which is precisely the dimensions fix the spec asks for. Everything else in the spec's detector section is unchanged.

---

## File Structure

| File                                          | Responsibility                                                    |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `AGENTS.md` (create)                          | Canonical agent instructions: architecture, commands, conventions |
| `CLAUDE.md` (create)                          | Pointer to `AGENTS.md` plus Claude-specific workflow              |
| `GEMINI.md` (create)                          | Pointer to `AGENTS.md`                                            |
| `.github/copilot-instructions.md` (create)    | Pointer plus inline summary                                       |
| `src/detector/artoolkit-detector.js` (create) | DOM-free wrapper over artoolkit5-ts. Owns state, dedup, backoff   |
| `src/worker/worker.js` (rewrite)              | Message pump: `ImageBitmap` → pixels → detector → `postMessage`   |
| `src/plugin.js` (modify)                      | Lifecycle, family-aware registry, event emission                  |
| `src/utils/matrix.js` (modify)                | Corrected documentation, deprecation notice                       |
| `tests/detector.spec.ts` (create)             | Detector core against a mocked artoolkit5-ts                      |
| `tests/plugin.markers.spec.ts` (create)       | Family independence: pattern 3 vs barcode 3                       |
| `tests/plugin.events.spec.ts` (create)        | Payload shape; `ar:getMarker` never emitted                       |
| `tests/plugin.stall.spec.ts` (create)         | Stall guard emits `markerLost` when frames stop                   |
| `examples/simple-marker/index.html` (modify)  | Two pattern markers, one anchor each                              |
| `README.md` (modify)                          | Upgrade notes, reserved `trackBarcode`                            |

---

## Task 1: Agent instruction files

Standalone and first, so every agent working on the remaining tasks — including the ones implementing this plan — shares one description of the repository.

**Files:**

- Create: `AGENTS.md`
- Create: `CLAUDE.md`
- Create: `GEMINI.md`
- Create: `.github/copilot-instructions.md`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed by code. Later tasks update `AGENTS.md` only if the architecture drifts from what it describes.

- [ ] **Step 1: Write `AGENTS.md`**

````markdown
# AGENTS.md

Instructions for coding agents working in this repository. This is the single
source of truth; `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md`
point here.

## What this is

`@ar-js-org/arjs-plugin-artoolkit` is the marker-detection plugin for
**AR.js-next**, a renderer-agnostic AR library built on an ECS architecture with
a plugin system. This plugin detects ARToolKit markers in camera frames and
emits marker lifecycle events on the engine's event bus. A renderer plugin such
as `arjs-plugin-threejs` subscribes to those events and moves objects in the
scene.

Detection runs in a Web Worker, off the main thread. Detection is
**browser-only**: it needs `Worker` and `OffscreenCanvas`. `worker: false`
exercises the plugin lifecycle in Node but detects nothing.

## Commands

```bash
npm test              # vitest
npm run coverage      # vitest with v8 coverage and thresholds
npm run build         # vite library build
npm run build:types   # tsc --emitDeclarationOnly
npm run format        # prettier --write .
npm run format:check  # prettier --check .
npm run lint          # eslint
npm run smoke:node    # dev/smoke-node.js lifecycle smoke test
npm run smoke:browser # http-server on :8080 for examples/
```

Node is pinned in `.nvmrc`. Use that exact version; CI does.

## Architecture

Three modules, each with one responsibility:

| Module                               | Responsibility                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `src/plugin.js`                      | Lifecycle (`init`/`enable`/`disable`/`dispose`), marker registry, event emission |
| `src/detector/artoolkit-detector.js` | DOM-free wrapper over artoolkit5-ts. Pixels in, poses out                        |
| `src/worker/worker.js`               | Message pump. Converts `ImageBitmap` to RGBA pixels, calls the detector          |

The detector touches no `self`, no `OffscreenCanvas` and no `postMessage`, which
is what makes it unit-testable without a Worker. Keep it that way: DOM and
message-passing concerns belong in the worker.

## Worker message protocol

| Direction     | Message            | Payload                                                          |
| ------------- | ------------------ | ---------------------------------------------------------------- |
| main → worker | `init`             | `{ cameraParametersUrl, wasmUrl, width, height, minConfidence }` |
| main → worker | `loadMarker`       | `{ patternUrl, size, requestId }`                                |
| main → worker | `processFrame`     | `{ frameId, imageBitmap, width, height }`                        |
| main → worker | `dispose`          | none                                                             |
| worker → main | `ready`            | none                                                             |
| worker → main | `loadMarkerResult` | `{ ok, markerId, size, requestId, error }`                       |
| worker → main | `detectionResult`  | `{ frameId, detected, lost }`                                    |
| worker → main | `error`            | `{ message }`                                                    |

`detected` entries are `{ id, type, confidence, matrixGL }`; `lost` entries are
`{ id, type }`.

## Event contract

| Event              | Payload                                             |
| ------------------ | --------------------------------------------------- |
| `ar:markerFound`   | `{ markerId, type, matrix, confidence, timestamp }` |
| `ar:markerUpdated` | `{ markerId, type, matrix, confidence, timestamp }` |
| `ar:markerLost`    | `{ markerId, type, timestamp }`                     |
| `ar:workerReady`   | `{}`                                                |
| `ar:workerError`   | `{ message }`                                       |

`matrix` is a `Float32Array(16)`, 4x4 column-major right-handed, ready for
WebGL and for `THREE.Matrix4.fromArray()`. It needs no conversion.

`type` is `"pattern"` or `"barcode"`. Pattern and barcode markers have
**independent ID registries** in artoolkit5-ts — both start at 0 — so the
plugin's internal registry is keyed `` `${type}:${id}` ``, never by ID alone.
Anything keyed on the bare ID will make pattern 3 and barcode 3 collide.

## Conventions

- ESM only. `"type": "module"`; no `require`.
- JSDoc on every exported function, class and public method.
- prettier formats everything; run `npm run format` before committing.
- husky runs on commit. `HUSKY=0` disables it in CI.
- Conventional commit prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.

## Testing

Vitest with jsdom. `tests/setupTests.ts` provides a `MockWorker` and a
`createEventBus()` helper — use the helper rather than hand-rolling an emitter.

Tests drive the plugin by calling `plugin._onWorkerMessage({ data: … })`
directly with a worker-shaped message. That is deliberate: it exercises the real
message handling without spawning a Worker.

The detector is tested against a `vi.mock`'d `@ar-js-org/artoolkit5-ts`. Never
load real WASM in a unit test.

`src/worker/**` is excluded from coverage — it is a message pump with no logic
worth asserting. Logic belongs in the detector or the plugin, where it can be
tested.

## Dependencies

`@ar-js-org/artoolkit5-ts` provides detection. It is data-oriented: plain
`ARToolKitState`, pure functions, no classes, no DOM, no event emitter. The
functions used here are `createARToolKitState`, `disposeARToolKitState`,
`loadPatternMarker`, `trackMarker`, `trackBarcodeMarker` and `processFrame`.

## Git

- Branch flow: feature branch → `dev` → `main`. Never commit directly to `main`.
- **Never pass `--author` or `-c user.name=…` to `git commit`.** Let the
  repository's own git config decide authorship. Overriding it has previously
  misattributed commits to the wrong GitHub account, and undoing that costs a
  `filter-branch` plus a force-push.
````

- [ ] **Step 2: Write `CLAUDE.md`**

```markdown
# CLAUDE.md

@AGENTS.md

The file above is the canonical description of this repository: architecture,
commands, the worker protocol, the event contract and the conventions. Read it
first.

## Claude-specific notes

- This repository uses the superpowers workflow. Design work goes through
  `superpowers:brainstorming` and lands in `docs/superpowers/specs/`;
  implementation plans live in `docs/superpowers/plans/`. Follow the plan
  task-by-task rather than improvising.
- Tests come before implementation. See `superpowers:test-driven-development`.
- **Never pass `--author` to `git commit`.** The session's user email is not the
  identity this repository commits under; only the repo's git config is.
```

- [ ] **Step 3: Write `GEMINI.md`**

```markdown
# GEMINI.md

See [AGENTS.md](./AGENTS.md).

That file is the canonical description of this repository — architecture,
commands, the worker message protocol, the event contract, testing approach and
git conventions. Everything an agent needs is there; this file exists only
because this tool looks for its own filename.
```

- [ ] **Step 4: Write `.github/copilot-instructions.md`**

Copilot does not follow `@`-includes, so this one carries a summary inline as well as the pointer.

```markdown
# GitHub Copilot instructions

The canonical instructions for this repository are in
[AGENTS.md](../AGENTS.md). Read it for the full architecture, worker protocol
and conventions. The essentials are repeated here because Copilot does not
follow includes.

## Summary

`@ar-js-org/arjs-plugin-artoolkit` is the marker-detection plugin for
AR.js-next. It detects ARToolKit markers in camera frames inside a Web Worker
and emits marker lifecycle events on the engine event bus.

Three modules: `src/plugin.js` (lifecycle, marker registry, events),
`src/detector/artoolkit-detector.js` (DOM-free wrapper over artoolkit5-ts,
pixels in and poses out), `src/worker/worker.js` (message pump). Keep DOM and
`postMessage` concerns in the worker; keep the detector free of both.

Events are `ar:markerFound`, `ar:markerUpdated` and `ar:markerLost`, with
payloads `{ markerId, type, matrix, confidence, timestamp }`. `matrix` is a
`Float32Array(16)`, 4x4 column-major, WebGL-ready. `type` is `"pattern"` or
`"barcode"`; the two families have independent ID registries, so marker state is
keyed by type and ID together, never by ID alone.

ESM only. JSDoc on public API. prettier formats everything. Vitest with jsdom
for tests; never load real WASM in a unit test. Conventional commit prefixes.
Branch flow is feature branch → `dev` → `main`.
```

- [ ] **Step 5: Format and verify the pointer targets resolve**

```bash
npm run format
ls AGENTS.md CLAUDE.md GEMINI.md .github/copilot-instructions.md
```

Expected: all four files listed, no prettier errors.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md CLAUDE.md GEMINI.md .github/copilot-instructions.md
git commit -m "docs: add canonical AGENTS.md and per-tool pointer files

AGENTS.md carries the architecture, worker protocol, event contract and
conventions. CLAUDE.md, GEMINI.md and .github/copilot-instructions.md
point at it so the four tools cannot drift apart.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Swap the dependency

**Files:**

- Modify: `package.json` (the `dependencies` block)
- Modify: `package-lock.json` (regenerated by npm)

**Interfaces:**

- Consumes: nothing.
- Produces: the module specifier `@ar-js-org/artoolkit5-ts`, imported by Task 3.

- [ ] **Step 1: Remove the old dependency and add the new one**

```bash
npm uninstall @ar-js-org/artoolkit5-js
npm install @ar-js-org/artoolkit5-ts@^0.2.0
```

- [ ] **Step 2: Verify the resolved versions**

```bash
npm ls @ar-js-org/artoolkit5-ts @ar-js-org/artoolkit5-wasm
```

Expected: `artoolkit5-ts` at `0.2.x`, and `artoolkit5-wasm` present as a transitive dependency.

The artoolkit5-ts README pins the WASM package at `^0.3.0` while its 0.2.0 release notes say `^0.2.0`. Record whichever version actually resolves in the commit message. If the two genuinely disagree, that is an upstream documentation bug worth reporting — do not "fix" it here.

- [ ] **Step 3: Confirm no import of the old package remains**

```bash
grep -rn "artoolkit5-js" src/ tests/ examples/ dev/ package.json
```

Expected: no matches in `package.json`. Matches in `src/worker/worker.js` are expected at this point and are removed in Task 4.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: replace artoolkit5-js with artoolkit5-ts 0.2.0

Records the resolved @ar-js-org/artoolkit5-wasm version, which the
upstream README and release notes disagree about.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The detector core

The heart of the migration, and the reason the architecture changed: this module is pure logic with no Worker or DOM dependency, so it can be tested directly.

**Files:**

- Create: `src/detector/artoolkit-detector.js`
- Test: `tests/detector.spec.ts`

**Interfaces:**

- Consumes: `@ar-js-org/artoolkit5-ts` — `createARToolKitState(width, height, cameraUrl, wasmUrl?)`, `disposeARToolKitState(state)`, `loadPatternMarker(state, markerUrl)`, `trackMarker(state, pattId, markerWidth)`, `processFrame(state, pixels)`.
- Produces, consumed by Task 4:
  - `createDetector(options)` → `Detector` (synchronous)
  - `detector.ensureReady(width, height)` → `Promise<boolean>`
  - `detector.loadPattern(patternUrl, size)` → `Promise<number>`
  - `detector.detect(pixels)` → `{ detected: Array<{id, type, confidence, matrixGL}>, lost: Array<{id, type}> }`
  - `detector.dispose()` → `void`

- [ ] **Step 1: Write the failing tests**

Create `tests/detector.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createARToolKitState: vi.fn(),
  disposeARToolKitState: vi.fn(),
  loadPatternMarker: vi.fn(),
  trackMarker: vi.fn(),
  processFrame: vi.fn(),
}));

vi.mock("@ar-js-org/artoolkit5-ts", () => mocks);

import { createDetector } from "../src/detector/artoolkit-detector.js";

describe("artoolkit-detector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createARToolKitState.mockResolvedValue({ id: "state" });
    mocks.loadPatternMarker.mockResolvedValue(7);
    mocks.processFrame.mockReturnValue({ detected: [], lost: [] });
  });

  it("creates state with the dimensions given to ensureReady, not at construction", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    expect(mocks.createARToolKitState).not.toHaveBeenCalled();

    await detector.ensureReady(1280, 720);

    expect(mocks.createARToolKitState).toHaveBeenCalledWith(
      1280,
      720,
      "/camera_para.dat",
      undefined,
    );
  });

  it("creates state only once across repeated ensureReady calls", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);
    await detector.ensureReady(640, 480);
    expect(mocks.createARToolKitState).toHaveBeenCalledTimes(1);
  });

  it("loads a pattern once per URL and tracks it", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);

    const first = await detector.loadPattern("/patt.hiro", 1);
    const second = await detector.loadPattern("/patt.hiro", 1);

    expect(first).toBe(7);
    expect(second).toBe(7);
    expect(mocks.loadPatternMarker).toHaveBeenCalledTimes(1);
    expect(mocks.trackMarker).toHaveBeenCalledWith({ id: "state" }, 7, 1);
  });

  it("loadPattern waits for readiness instead of failing when called first", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });

    const pending = detector.loadPattern("/patt.hiro", 1);
    await detector.ensureReady(640, 480);

    await expect(pending).resolves.toBe(7);
    expect(mocks.loadPatternMarker).toHaveBeenCalledTimes(1);
  });

  it("passes detected and lost markers through", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);
    const pose = {
      id: 3,
      type: "pattern",
      confidence: 0.9,
      matrixGL: new Float32Array(16),
    };
    mocks.processFrame.mockReturnValue({
      detected: [pose],
      lost: [{ id: 4, type: "barcode" }],
    });

    const pixels = new Uint8ClampedArray(4);
    const result = detector.detect(pixels);

    expect(result.detected).toEqual([pose]);
    expect(result.lost).toEqual([{ id: 4, type: "barcode" }]);
  });

  it("filters detections below minConfidence", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
      minConfidence: 0.6,
    });
    await detector.ensureReady(640, 480);
    mocks.processFrame.mockReturnValue({
      detected: [
        {
          id: 1,
          type: "pattern",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
        },
        {
          id: 2,
          type: "pattern",
          confidence: 0.3,
          matrixGL: new Float32Array(16),
        },
      ],
      lost: [],
    });

    const result = detector.detect(new Uint8ClampedArray(4));

    expect(result.detected).toHaveLength(1);
    expect(result.detected[0].id).toBe(1);
  });

  it("applies a 0.6 confidence floor by default, matching pre-migration behaviour", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);
    mocks.processFrame.mockReturnValue({
      detected: [
        {
          id: 1,
          type: "pattern",
          confidence: 0.61,
          matrixGL: new Float32Array(16),
        },
        {
          id: 2,
          type: "pattern",
          confidence: 0.59,
          matrixGL: new Float32Array(16),
        },
      ],
      lost: [],
    });

    const result = detector.detect(new Uint8ClampedArray(4));

    expect(result.detected).toHaveLength(1);
    expect(result.detected[0].id).toBe(1);
  });

  it("returns empty results when detect is called before readiness", () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    expect(detector.detect(new Uint8ClampedArray(4))).toEqual({
      detected: [],
      lost: [],
    });
    expect(mocks.processFrame).not.toHaveBeenCalled();
  });

  it("backs off after a failed init instead of retrying every frame", async () => {
    mocks.createARToolKitState.mockRejectedValue(new Error("wasm missing"));
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });

    await expect(detector.ensureReady(640, 480)).resolves.toBe(false);
    await expect(detector.ensureReady(640, 480)).resolves.toBe(false);

    expect(mocks.createARToolKitState).toHaveBeenCalledTimes(1);
  });

  it("disposes the state and refuses further work", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);

    detector.dispose();
    detector.dispose();

    expect(mocks.disposeARToolKitState).toHaveBeenCalledTimes(1);
    expect(detector.detect(new Uint8ClampedArray(4))).toEqual({
      detected: [],
      lost: [],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/detector.spec.ts`

Expected: FAIL — `Failed to resolve import "../src/detector/artoolkit-detector.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/detector/artoolkit-detector.js`:

```js
/**
 * @fileoverview DOM-free detection core wrapping artoolkit5-ts.
 *
 * Takes RGBA pixels and returns marker poses. Deliberately free of `self`,
 * `OffscreenCanvas` and `postMessage` so it can be unit-tested without a
 * Worker; those concerns belong to `src/worker/worker.js`.
 *
 * @module detector/artoolkit-detector
 */

import {
  createARToolKitState,
  disposeARToolKitState,
  loadPatternMarker,
  processFrame,
  trackMarker,
} from "@ar-js-org/artoolkit5-ts";

/** Camera calibration used when the caller supplies none. */
const DEFAULT_CAMERA_URL =
  "https://raw.githack.com/AR-js-org/AR.js/master/data/data/camera_para.dat";

/** Longest backoff between failed initialisation attempts, in milliseconds. */
const MAX_BACKOFF_MS = 30000;

/** Hard ceiling on the backoff exponent, so the delay cannot run away. */
const MAX_FAIL_COUNT = 6;

/**
 * Confidence floor applied when the caller supplies none.
 *
 * Matches the gate the worker applied before the artoolkit5-ts migration, so
 * detection behaviour is preserved rather than silently loosened.
 */
const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Create a detector.
 *
 * Construction is cheap and synchronous: no WASM is loaded until
 * {@link Detector#ensureReady} supplies real frame dimensions.
 * `createARToolKitState` fixes width and height permanently, so guessing them
 * at construction would calibrate detection against the wrong intrinsics.
 *
 * @param {Object} [options]
 * @param {string} [options.cameraParametersUrl] - Camera calibration file URL
 * @param {string} [options.wasmUrl] - Explicit URL for the ARToolKit WASM binary
 * @param {number} [options.minConfidence=0.6] - Drop detections below this
 *   confidence (0-1). The default matches the gate the worker applied before
 *   this migration, so detection behaviour is unchanged. artoolkit5-ts can
 *   filter per family via `configureDetector`, which is where this belongs once
 *   that option is exposed.
 * @returns {Detector}
 */
export function createDetector(options = {}) {
  const {
    cameraParametersUrl = DEFAULT_CAMERA_URL,
    wasmUrl,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
  } = options;

  /** @type {Object|null} */
  let state = null;
  /** @type {Promise<boolean>|null} */
  let initInProgress = null;
  let failCount = 0;
  let failedUntil = 0;
  let disposed = false;

  /** Resolves once state exists, so loadPattern can be called before readiness. */
  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  /** @type {Map<string, number>} patternUrl -> markerId */
  const loaded = new Map();
  /** @type {Map<string, Promise<number>>} patternUrl -> in-flight load */
  const loading = new Map();

  /**
   * Create the ARToolKit state if it does not exist yet.
   *
   * Applies exponential backoff after a failure so a missing WASM binary does
   * not trigger a fresh attempt on every frame.
   *
   * @param {number} width - Frame width in pixels
   * @param {number} height - Frame height in pixels
   * @returns {Promise<boolean>} True once state exists
   */
  async function ensureReady(width, height) {
    if (disposed) return false;
    if (state) return true;

    if (Date.now() < failedUntil) return false;
    if (initInProgress) return initInProgress;

    initInProgress = (async () => {
      try {
        state = await createARToolKitState(
          width,
          height,
          cameraParametersUrl,
          wasmUrl,
        );
        failCount = 0;
        failedUntil = 0;
        resolveReady(state);
        return true;
      } catch (err) {
        state = null;
        failCount = Math.min(failCount + 1, MAX_FAIL_COUNT);
        failedUntil =
          Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failCount);
        return false;
      } finally {
        initInProgress = null;
      }
    })();

    return initInProgress;
  }

  /**
   * Load a pattern marker and start tracking it.
   *
   * Deduplicated by URL: loading the same pattern twice returns the same ID
   * without a second network fetch. Safe to call before {@link ensureReady} —
   * the load waits for state to exist rather than failing.
   *
   * @param {string} patternUrl - URL of the .patt file
   * @param {number} [size=1] - Marker width in world units
   * @returns {Promise<number>} The marker ID assigned by ARToolKit
   */
  async function loadPattern(patternUrl, size = 1) {
    if (loaded.has(patternUrl)) return loaded.get(patternUrl);
    if (loading.has(patternUrl)) return loading.get(patternUrl);

    const pending = (async () => {
      const readyState = await readyPromise;
      const markerId = await loadPatternMarker(readyState, patternUrl);
      trackMarker(readyState, markerId, size);
      loaded.set(patternUrl, markerId);
      loading.delete(patternUrl);
      return markerId;
    })().catch((err) => {
      loading.delete(patternUrl);
      throw err;
    });

    loading.set(patternUrl, pending);
    return pending;
  }

  /**
   * Detect markers in one frame.
   *
   * @param {Uint8ClampedArray} pixels - RGBA pixel data for the whole frame
   * @returns {{detected: Array<Object>, lost: Array<Object>}} Poses found this
   *   frame and markers that disappeared since the last one. Both empty when
   *   the detector is not ready.
   */
  function detect(pixels) {
    if (!state || disposed) return { detected: [], lost: [] };

    const result = processFrame(state, pixels);
    const detected =
      minConfidence > 0
        ? result.detected.filter((pose) => pose.confidence >= minConfidence)
        : result.detected;

    return { detected, lost: result.lost };
  }

  /**
   * Release the ARToolKit state and its WASM resources.
   *
   * Idempotent. After disposal {@link detect} returns empty results rather than
   * throwing, so an in-flight frame cannot crash the worker.
   *
   * @returns {void}
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (state) {
      disposeARToolKitState(state);
      state = null;
    }
  }

  /**
   * @typedef {Object} Detector
   * @property {(width: number, height: number) => Promise<boolean>} ensureReady
   * @property {(patternUrl: string, size?: number) => Promise<number>} loadPattern
   * @property {(pixels: Uint8ClampedArray) => {detected: Array<Object>, lost: Array<Object>}} detect
   * @property {() => void} dispose
   */
  return { ensureReady, loadPattern, detect, dispose };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/detector.spec.ts`

Expected: PASS, 10 tests.

Note that every test calling `detect()` must `await detector.ensureReady(…)` first — `detect()` deliberately returns empty results before state exists, which is what the "before readiness" test asserts.

- [ ] **Step 5: Format and commit**

```bash
npm run format
git add src/detector/artoolkit-detector.js tests/detector.spec.ts
git commit -m "feat: add DOM-free detector core over artoolkit5-ts

Pixels in, poses out. Owns the ARToolKit state, pattern-URL dedup and
init backoff, with no Worker or DOM dependency, so the detection logic
is unit-testable for the first time.

State creation defers until ensureReady supplies real frame dimensions:
createARToolKitState fixes width and height permanently, so initialising
at a guessed 640x480 calibrated detection against the wrong intrinsics.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Rewrite the worker as a message pump

**Files:**

- Rewrite: `src/worker/worker.js` (replaces all 400+ lines)

**Interfaces:**

- Consumes: `createDetector` from Task 3.
- Produces: the worker message protocol in Global Constraints, consumed by `plugin.js` in Tasks 5-7.

`src/worker/**` is excluded from coverage: it has no logic worth asserting once the detector owns it all. It is verified by the browser smoke test in Task 10.

- [ ] **Step 1: Replace the file contents**

```js
/**
 * @fileoverview ARToolKit detection worker.
 *
 * A message pump, nothing more. Converts each incoming `ImageBitmap` to RGBA
 * pixels through an `OffscreenCanvas` and hands them to the detector, then
 * posts the results back. All detection logic lives in
 * `src/detector/artoolkit-detector.js`, where it can be tested without a
 * Worker.
 *
 * Browser-only: requires `OffscreenCanvas` and the Worker global scope.
 *
 * @module worker/worker
 */

import { createDetector } from "../detector/artoolkit-detector.js";

/** @type {ReturnType<typeof createDetector>|null} */
let detector = null;

let offscreenCanvas = null;
let offscreenCtx = null;
let canvasW = 0;
let canvasH = 0;
let hasAnnouncedReady = false;

/**
 * Post a message to the main thread.
 *
 * @param {Object} msg - Message with a `type` and optional `payload`
 * @private
 */
function sendMessage(msg) {
  self.postMessage(msg);
}

/**
 * Ensure the OffscreenCanvas matches the frame size, reallocating on change.
 *
 * @param {number} width - Frame width in pixels
 * @param {number} height - Frame height in pixels
 * @private
 */
function ensureCanvas(width, height) {
  if (offscreenCanvas && canvasW === width && canvasH === height) return;
  canvasW = width;
  canvasH = height;
  offscreenCanvas = new OffscreenCanvas(width, height);
  offscreenCtx = offscreenCanvas.getContext("2d", {
    willReadFrequently: true,
  });
}

self.addEventListener("message", async (ev) => {
  const { type, payload } = ev.data || {};

  try {
    if (type === "init") {
      // The plugin's watchdog resends init if `ready` was slow to arrive.
      // Constructing a second detector here would discard the ARToolKit state
      // and every pattern loaded so far, so init is idempotent.
      if (!detector) {
        detector = createDetector({
          cameraParametersUrl: payload?.cameraParametersUrl ?? undefined,
          wasmUrl: payload?.wasmUrl ?? undefined,
          minConfidence: payload?.minConfidence ?? undefined,
        });
      }

      // Dimensions are optional here; the first frame supplies them otherwise.
      if (payload?.width && payload?.height) {
        await detector.ensureReady(payload.width, payload.height);
      }

      if (!hasAnnouncedReady) {
        sendMessage({ type: "ready" });
        hasAnnouncedReady = true;
      }
      return;
    }

    if (type === "loadMarker") {
      const { patternUrl, size = 1, requestId } = payload || {};

      if (!patternUrl) {
        sendMessage({
          type: "loadMarkerResult",
          payload: {
            ok: false,
            error: "Missing patternUrl parameter",
            requestId,
          },
        });
        return;
      }

      if (!detector) {
        sendMessage({
          type: "loadMarkerResult",
          payload: { ok: false, error: "Detector not initialised", requestId },
        });
        return;
      }

      try {
        const markerId = await detector.loadPattern(patternUrl, size);
        sendMessage({
          type: "loadMarkerResult",
          payload: { ok: true, markerId, size, requestId },
        });
      } catch (err) {
        sendMessage({
          type: "loadMarkerResult",
          payload: { ok: false, error: err?.message || String(err), requestId },
        });
      }
      return;
    }

    if (type === "processFrame") {
      const { frameId, imageBitmap, width, height } = payload || {};
      if (!imageBitmap || !detector) return;

      const w = width || imageBitmap.width || 640;
      const h = height || imageBitmap.height || 480;

      await detector.ensureReady(w, h);
      ensureCanvas(w, h);

      offscreenCtx.clearRect(0, 0, w, h);
      offscreenCtx.drawImage(imageBitmap, 0, 0, w, h);
      imageBitmap.close?.();

      const pixels = offscreenCtx.getImageData(0, 0, w, h).data;
      const { detected, lost } = detector.detect(pixels);

      if (detected.length || lost.length) {
        sendMessage({
          type: "detectionResult",
          payload: { frameId, detected, lost },
        });
      }
      return;
    }

    if (type === "dispose") {
      detector?.dispose();
      detector = null;
      return;
    }
  } catch (err) {
    sendMessage({
      type: "error",
      payload: { message: err?.message || String(err) },
    });
  }
});

// Announce readiness immediately, in case `init` is delayed.
if (!hasAnnouncedReady) {
  sendMessage({ type: "ready" });
  hasAnnouncedReady = true;
}
```

- [ ] **Step 2: Verify nothing references the removed helpers or the old package**

```bash
grep -rn "serializeGetMarkerEvent\|shouldForwardGetMarker\|attachGetMarkerForwarder\|PATTERN_MARKER_TYPE\|artoolkit5-js" src/
```

Expected: no matches.

- [ ] **Step 3: Verify the build still bundles the worker**

Run: `npm run build`

Expected: build succeeds; `dist/` contains the worker chunk.

- [ ] **Step 4: Run the full suite**

Run: `npm test`

Expected: `tests/detector.spec.ts` passes. Existing plugin specs still pass — they drive `_onWorkerMessage` directly and do not touch the worker file. Task 5 changes that.

- [ ] **Step 5: Format and commit**

```bash
npm run format
git add src/worker/worker.js
git commit -m "refactor: reduce the worker to a message pump

Detection moves to the detector core. The worker now only converts
ImageBitmap to RGBA pixels and relays results.

Deletes serializeGetMarkerEvent, shouldForwardGetMarker,
attachGetMarkerForwarder, PATTERN_MARKER_TYPE and the module-level
confidence gate: artoolkit5-ts has no event emitter, so there is nothing
left to serialise or filter at this layer.

Adds a dispose message so disposeARToolKitState releases WASM resources
before the worker is terminated.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Family-aware registry and the new event contract

The breaking change. Existing specs assert the old payload shape, so they are updated here, in the same task that breaks them.

**Files:**

- Modify: `src/plugin.js` — `_applyDetections` and the `_onWorkerMessage` handler
- Test: `tests/plugin.markers.spec.ts` (create)
- Test: `tests/plugin.events.spec.ts` (create)
- Modify: `tests/plugin.spec.ts`, `tests/plugin.more.spec.ts`, `tests/plugin.extra.spec.ts`

**Interfaces:**

- Consumes: the `detectionResult` message from Task 4 — `{ frameId, detected, lost }`.
- Produces: `ar:markerFound` / `ar:markerUpdated` with `{ markerId, type, matrix, confidence, timestamp }`; internal registry keyed `` `${type}:${id}` ``.

- [ ] **Step 1: Write the failing tests**

Create `tests/plugin.markers.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

/** Build a detectionResult message as the worker would send it. */
function detectionResult(detected: unknown[], lost: unknown[] = []) {
  return {
    data: { type: "detectionResult", payload: { frameId: 1, detected, lost } },
  };
}

describe("marker families are tracked independently", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  it("treats pattern 3 and barcode 3 as different markers", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    core.eventBus.on("ar:markerFound", found);

    // @ts-ignore private handler driven directly, as the other specs do
    plugin._onWorkerMessage(
      detectionResult([
        {
          id: 3,
          type: "pattern",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
        },
        {
          id: 3,
          type: "barcode",
          confidence: 0.8,
          matrixGL: new Float32Array(16),
        },
      ]),
    );

    expect(found).toHaveBeenCalledTimes(2);
    expect(found.mock.calls[0][0].type).toBe("pattern");
    expect(found.mock.calls[1][0].type).toBe("barcode");

    await plugin.disable();
  });

  it("losing pattern 3 leaves barcode 3 tracked", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    // @ts-ignore
    plugin._onWorkerMessage(
      detectionResult([
        {
          id: 3,
          type: "pattern",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
        },
        {
          id: 3,
          type: "barcode",
          confidence: 0.8,
          matrixGL: new Float32Array(16),
        },
      ]),
    );

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 3, type: "pattern" }]));

    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0][0]).toMatchObject({
      markerId: 3,
      type: "pattern",
    });
    expect(plugin.getMarkerState(3, "barcode")).not.toBeNull();
    expect(plugin.getMarkerState(3, "pattern")).toBeNull();

    await plugin.disable();
  });

  it("emits markerUpdated on the second sighting of the same marker", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    const updated = vi.fn();
    core.eventBus.on("ar:markerFound", found);
    core.eventBus.on("ar:markerUpdated", updated);

    const pose = {
      id: 1,
      type: "pattern",
      confidence: 0.9,
      matrixGL: new Float32Array(16),
    };
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose]));
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose]));

    expect(found).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);

    await plugin.disable();
  });

  it("ignores a lost report for a marker it never saw", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 99, type: "pattern" }]));

    expect(lost).not.toHaveBeenCalled();

    await plugin.disable();
  });
});
```

Create `tests/plugin.events.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

describe("event payload contract", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  it("emits markerId, type, matrix, confidence and timestamp", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    core.eventBus.on("ar:markerFound", found);

    const matrixGL = new Float32Array(16).fill(2);
    // @ts-ignore
    plugin._onWorkerMessage({
      data: {
        type: "detectionResult",
        payload: {
          frameId: 1,
          detected: [{ id: 5, type: "pattern", confidence: 0.77, matrixGL }],
          lost: [],
        },
      },
    });

    const payload = found.mock.calls[0][0];
    expect(payload.markerId).toBe(5);
    expect(payload.type).toBe("pattern");
    expect(payload.confidence).toBeCloseTo(0.77);
    expect(payload.matrix).toBeInstanceOf(Float32Array);
    expect(payload.matrix).toHaveLength(16);
    expect(typeof payload.timestamp).toBe("number");

    // The old names are gone, not merely deprecated.
    expect(payload.id).toBeUndefined();
    expect(payload.poseMatrix).toBeUndefined();
    expect(payload.corners).toBeUndefined();

    await plugin.disable();
  });

  it("never emits ar:getMarker", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const getMarker = vi.fn();
    core.eventBus.on("ar:getMarker", getMarker);

    // @ts-ignore  a getMarker message must not be translated into an event
    plugin._onWorkerMessage({
      data: { type: "getMarker", payload: { marker: { idPatt: 1 } } },
    });

    expect(getMarker).not.toHaveBeenCalled();

    await plugin.disable();
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- tests/plugin.markers.spec.ts tests/plugin.events.spec.ts`

Expected: FAIL. `getMarkerState` takes one argument, payloads still carry `id` and `poseMatrix`, and `detected` entries are ignored because the handler reads `payload.detections`.

- [ ] **Step 3: Replace `_applyDetections` in `src/plugin.js`**

Replace the whole `_applyDetections` method with:

```js
  /**
   * Build the registry key for a marker.
   *
   * Pattern and barcode markers have independent ID registries in
   * artoolkit5-ts — both start at 0 — so the family is part of the identity.
   * Keying on the bare ID would make pattern 3 and barcode 3 the same marker.
   *
   * @param {number} id - Marker ID within its family
   * @param {string} type - Marker family, 'pattern' or 'barcode'
   * @returns {string} Registry key
   * @private
   */
  _markerKey(id, type) {
    return `${type}:${id}`;
  }

  /**
   * Apply detection results and emit marker events.
   *
   * A marker not currently visible emits `ar:markerFound`; one already visible
   * emits `ar:markerUpdated`.
   *
   * @param {Array<Object>} detected - Poses from the worker
   * @param {number} detected[].id - Marker ID within its family
   * @param {string} detected[].type - 'pattern' or 'barcode'
   * @param {number} detected[].confidence - Match confidence, 0-1
   * @param {Float32Array} detected[].matrixGL - 4x4 column-major pose
   * @private
   */
  _applyDetections(detected) {
    if (!Array.isArray(detected)) return;

    for (const pose of detected) {
      const { id, type } = pose || {};
      if (id === null || id === undefined || !type) continue;

      const now = Date.now();
      const key = this._markerKey(id, type);
      const matrix =
        pose.matrixGL instanceof Float32Array
          ? pose.matrixGL
          : new Float32Array(pose.matrixGL || 16);
      const confidence = pose.confidence ?? 0;

      const prev = this._markers.get(key);
      const payload = {
        markerId: id,
        type,
        matrix,
        confidence,
        timestamp: now,
      };

      if (!prev || !prev.visible) {
        this._markers.set(key, { lastSeen: now, visible: true, id, type });
        this.core?.eventBus?.emit("ar:markerFound", payload);
      } else {
        prev.lastSeen = now;
        this._markers.set(key, prev);
        this.core?.eventBus?.emit("ar:markerUpdated", payload);
      }
    }
  }

  /**
   * Emit `ar:markerLost` for markers the detector reports as gone.
   *
   * A lost report for an untracked marker is ignored: confidence filtering can
   * drop a detection the library still considers tracked, so the plugin may
   * never have seen it.
   *
   * @param {Array<Object>} lost - Entries of `{ id, type }`
   * @private
   */
  _applyLost(lost) {
    if (!Array.isArray(lost)) return;

    for (const entry of lost) {
      const { id, type } = entry || {};
      if (id === null || id === undefined || !type) continue;

      const key = this._markerKey(id, type);
      if (!this._markers.has(key)) continue;

      this._markers.delete(key);
      this.core?.eventBus?.emit("ar:markerLost", {
        markerId: id,
        type,
        timestamp: Date.now(),
      });
    }
  }
```

- [ ] **Step 4: Replace the `detectionResult` and `getMarker` branches in `_onWorkerMessage`**

Delete the entire `else if (type === "getMarker") { … }` branch, and replace the `detectionResult` branch with:

```js
    } else if (type === "detectionResult") {
      if (!payload) return;
      this._applyDetections(payload.detected);
      this._applyLost(payload.lost);
```

- [ ] **Step 5: Update `getMarkerState` to take the family**

```js
  /**
   * Get the current tracking state of a marker.
   *
   * @param {number} markerId - Marker ID within its family
   * @param {string} [type='pattern'] - Marker family, 'pattern' or 'barcode'
   * @returns {Object|null} State with `lastSeen`, `visible`, `id` and `type`,
   *   or null if the marker is not tracked
   *
   * @example
   * const state = plugin.getMarkerState(42, 'pattern');
   * if (state && state.visible) console.log('last seen', state.lastSeen);
   */
  getMarkerState(markerId, type = "pattern") {
    return this._markers.get(this._markerKey(markerId, type)) || null;
  }
```

- [ ] **Step 6: Update the existing specs for the new payload**

In `tests/plugin.spec.ts`, `tests/plugin.more.spec.ts` and `tests/plugin.extra.spec.ts`:

- Replace `payload: { detections: [...] }` with `payload: { frameId: 1, detected: [...], lost: [] }`.
- Replace each detection `{ id, confidence, poseMatrix, corners }` with `{ id, type: "pattern", confidence, matrixGL: new Float32Array(16) }`.
- Replace assertions on `payload.id` with `payload.markerId`, and `payload.poseMatrix` with `payload.matrix`.
- Delete any assertion referencing `corners` or `ar:getMarker`; those are gone by design.
- Pass `"pattern"` as the second argument to every `getMarkerState` call.

- [ ] **Step 7: Run the full suite**

Run: `npm test`

Expected: PASS, including the two new spec files.

- [ ] **Step 8: Format and commit**

```bash
npm run format
git add src/plugin.js tests/
git commit -m "feat!: family-aware marker registry and AR.js-next payload names

BREAKING CHANGE: ar:getMarker is removed, event payloads rename id to
markerId and poseMatrix to matrix, corners is gone, and getMarkerState
takes the marker family as a second argument.

Pattern and barcode markers have independent ID registries in
artoolkit5-ts, both starting at 0, so the registry is keyed by family
and ID together. Keyed on the bare ID, pattern 3 and barcode 3 would
share one entry - and one THREE.Group anchor downstream, since
arjs-plugin-threejs keys anchors on the stringified ID.

markerId and matrix match AR.js-next's documented contract; the old
names only worked because arjs-plugin-threejs tries both spellings.

corners was never correct: artoolkit5-js reports vertex as four [x,y]
pairs and plugin.js unpacked it as a flat array. Nothing consumed it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Lost markers from the library, sweep as staleness guard

**Files:**

- Modify: `src/plugin.js` — `_sweepMarkers`
- Test: `tests/plugin.stall.spec.ts` (create)

**Interfaces:**

- Consumes: `_applyLost` and the `_markerKey` helper from Task 5.
- Produces: no new API. `ar:markerLost` now has two sources — the library, and staleness.

- [ ] **Step 1: Write the failing test**

Create `tests/plugin.stall.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

describe("staleness guard", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    vi.useFakeTimers();
    core = { eventBus: createEventBus() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits markerLost when frames stop arriving", async () => {
    const plugin = new ArtoolkitPlugin({
      worker: false,
      lostThreshold: 2,
      frameDurationMs: 100,
      sweepIntervalMs: 50,
    });
    await plugin.init(core);
    await plugin.enable();

    // @ts-ignore
    plugin._onWorkerMessage({
      data: {
        type: "detectionResult",
        payload: {
          frameId: 1,
          detected: [
            {
              id: 1,
              type: "pattern",
              confidence: 0.9,
              matrixGL: new Float32Array(16),
            },
          ],
          lost: [],
        },
      },
    });

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // No further frames: lostThreshold * frameDurationMs = 200ms
    vi.advanceTimersByTime(400);

    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0][0]).toMatchObject({
      markerId: 1,
      type: "pattern",
    });

    await plugin.disable();
  });

  it("does not sweep a marker that keeps being detected", async () => {
    const plugin = new ArtoolkitPlugin({
      worker: false,
      lostThreshold: 2,
      frameDurationMs: 100,
      sweepIntervalMs: 50,
    });
    await plugin.init(core);
    await plugin.enable();

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    const pose = {
      id: 1,
      type: "pattern",
      confidence: 0.9,
      matrixGL: new Float32Array(16),
    };
    for (let i = 0; i < 6; i++) {
      // @ts-ignore
      plugin._onWorkerMessage({
        data: {
          type: "detectionResult",
          payload: { frameId: i, detected: [pose], lost: [] },
        },
      });
      vi.advanceTimersByTime(50);
    }

    expect(lost).not.toHaveBeenCalled();

    await plugin.disable();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/plugin.stall.spec.ts`

Expected: FAIL — the sweep still emits `{ id, timestamp }` without `markerId` or `type`.

- [ ] **Step 3: Rewrite `_sweepMarkers`**

```js
  /**
   * Emit `ar:markerLost` for markers that have gone stale.
   *
   * The detector reports losses itself, on the frame a marker disappears, and
   * that is the primary path. This sweep covers what the detector structurally
   * cannot see: frames that stop arriving at all — a stalled camera, a
   * backgrounded tab, a dead worker — where `processFrame` is never called and
   * a visible marker would otherwise stay visible forever.
   *
   * @private
   */
  _sweepMarkers() {
    const now = Date.now();
    const lostThresholdMs = this.lostThreshold * this.frameDurationMs;

    for (const [key, state] of this._markers.entries()) {
      if (now - (state.lastSeen || 0) <= lostThresholdMs) continue;

      this._markers.delete(key);
      this.core?.eventBus?.emit("ar:markerLost", {
        markerId: state.id,
        type: state.type,
        timestamp: now,
      });
    }
  }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npm run format
git add src/plugin.js tests/plugin.stall.spec.ts
git commit -m "feat: emit markerLost from library reports, keep sweep as staleness guard

artoolkit5-ts reports lost markers on the frame they disappear, which is
more accurate than inferring loss from a timer. The interval sweep stays
for the case the library cannot observe: frames stop arriving entirely,
so processFrame is never called and nothing would ever be reported lost.

lostThreshold, frameDurationMs and sweepIntervalMs keep their names and
meanings.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Browser-only worker, dispose, and the wasmUrl rename

**Files:**

- Modify: `src/plugin.js` — constructor options, `_startWorker`, `_stopWorker`, `_onWorkerMessage`, `disable`, `_onEngineUpdate`
- Modify: `dev/smoke-node.js` (comment only)

**Interfaces:**

- Consumes: the `dispose` message added in Task 4.
- Produces: renamed option `wasmUrl` replacing `artoolkitModuleUrl`.

- [ ] **Step 1: Rename the option and declare `minConfidence` in the constructor**

In the options block, replace `artoolkitModuleUrl: undefined,` with:

```js
      wasmUrl: undefined,
      minConfidence: 0.6,
```

`minConfidence` was never a plugin option — the worker hardcoded `0.6` and only accepted an override through the raw `init` message. Declaring it here keeps that default while making it reachable from the public constructor, and `_startWorker` already forwards `this.options.minConfidence`.

Update the class JSDoc: replace the `@param {string} [options.artoolkitModuleUrl]` line with

```
 * @param {string} [options.wasmUrl] - Explicit URL for the ARToolKit WASM binary
 * @param {number} [options.minConfidence=0.6] - Drop detections below this confidence (0-1)
```

Also update the class JSDoc `@fires` list: delete the `ar:getMarker` line.

- [ ] **Step 2: Simplify `_startWorker` to the browser path**

```js
  /**
   * Start the detection worker.
   *
   * Browser-only: detection needs `Worker` and `OffscreenCanvas`. With
   * `worker: false` the plugin runs its lifecycle without detecting anything,
   * which is what `dev/smoke-node.js` exercises under Node.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _startWorker() {
    if (this._worker) return;

    if (typeof Worker === "undefined") {
      console.warn(
        "[ArtoolkitPlugin] Worker is unavailable; detection is browser-only.",
      );
      return;
    }

    this._worker = new Worker(new URL("./worker/worker.js", import.meta.url), {
      type: "module",
    });
    this._worker.addEventListener("message", this._onWorkerMessage);

    this._worker.postMessage({
      type: "init",
      payload: {
        cameraParametersUrl: this.options.cameraParametersUrl || null,
        wasmUrl: this.options.wasmUrl || null,
        minConfidence: this.options.minConfidence,
      },
    });

    // Watchdog: resend init once if 'ready' did not arrive promptly.
    setTimeout(() => {
      if (!this.workerReady) {
        this._worker?.postMessage({ type: "init", payload: {} });
      }
    }, 500);
  }
```

- [ ] **Step 3: Dispose the detector before terminating**

```js
  /**
   * Stop and terminate the detection worker.
   *
   * Asks the worker to release its ARToolKit state before terminating, so WASM
   * resources are freed rather than abandoned.
   *
   * @private
   */
  _stopWorker() {
    if (!this._worker) return;

    try {
      this._worker.postMessage({ type: "dispose" });
    } catch {
      // Worker may already be gone; termination below is what matters.
    }

    this._worker.removeEventListener("message", this._onWorkerMessage);
    this._worker.terminate();
    this._worker = null;
  }
```

- [ ] **Step 4: Simplify `_onWorkerMessage` and `_onEngineUpdate`**

In `_onWorkerMessage`, replace the first line with:

```js
const { type, payload } = ev.data || {};
```

In `_onEngineUpdate`, delete the `else` branch that posts a frameId-only message for Node, and the `typeof Worker !== "undefined"` check around the transfer — the worker is browser-only now. Keep the `try`/`catch` and the no-ImageBitmap fallback.

- [ ] **Step 5: Update the smoke test comment**

In `dev/smoke-node.js`, replace the comment above the plugin construction with:

```js
// worker:false in Node: detection is browser-only (needs Worker and
// OffscreenCanvas). This exercises the plugin lifecycle only.
```

- [ ] **Step 6: Verify the Node path is gone and both smoke paths work**

```bash
grep -rn "worker_threads\|node:worker_threads\|fileURLToPath" src/
npm test
npm run smoke:node
```

Expected: no grep matches; tests pass; the smoke test logs a version and exits cleanly.

- [ ] **Step 7: Format and commit**

```bash
npm run format
git add src/plugin.js dev/smoke-node.js
git commit -m "refactor!: drop the worker_threads path, rename artoolkitModuleUrl to wasmUrl

BREAKING CHANGE: the artoolkitModuleUrl option is now wasmUrl, matching
createARToolKitState's parameter.

The worker_threads branch never worked: the worker uses self.addEventListener
and OffscreenCanvas, which throw immediately under worker_threads, and
smoke-node.js sidesteps it with worker:false. Removing it also removes a
cross-platform claim the code never honoured.

_stopWorker now asks the worker to dispose its ARToolKit state before
terminating, so WASM resources are released rather than abandoned.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Matrix utility documentation and coverage thresholds

**Files:**

- Modify: `src/utils/matrix.js`
- Modify: `src/index.js` (JSDoc only)
- Modify: `vitest.config.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: no signature change. `convertModelViewToThreeMatrix(modelViewArray)` still returns a `Float32Array(16)`.

- [ ] **Step 1: Replace the body of `src/utils/matrix.js`**

```js
/**
 * @fileoverview Matrix helpers for ARToolKit poses.
 */

/**
 * Copy a 16-element pose matrix into a fresh `Float32Array`.
 *
 * @deprecated No conversion is needed for poses from artoolkit5-ts. The
 * `matrix` field on `ar:markerFound` and `ar:markerUpdated` is already
 * `matrixGL`: 4x4 column-major right-handed, ready for WebGL and for
 * `THREE.Matrix4.fromArray()`. This function now only makes a defensive copy,
 * and is kept so existing callers do not break. It will be removed in a future
 * release.
 *
 * @param {Float32Array|Array<number>} modelViewArray - 16-element pose matrix
 * @returns {Float32Array} A copy of the input
 *
 * @example
 * // Preferred: use the event payload directly.
 * eventBus.on('ar:markerFound', ({ matrix }) => {
 *   object.matrixAutoUpdate = false;
 *   object.matrix.fromArray(matrix);
 * });
 */
export function convertModelViewToThreeMatrix(modelViewArray) {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = modelViewArray[i];
  return out;
}
```

- [ ] **Step 2: Update the export comment in `src/index.js`**

Replace the comment block above the `convertModelViewToThreeMatrix` export with:

```js
/**
 * Copies a 16-element pose matrix.
 *
 * @deprecated Poses from artoolkit5-ts need no conversion; the `matrix` field
 * on marker events is already WebGL-ready.
 */
```

- [ ] **Step 3: Raise the coverage thresholds in `vitest.config.ts`**

The detector is covered by the existing `src/**/*.js` include and is deliberately absent from `exclude`; only the thresholds change.

```ts
      thresholds: {
        lines: 75,
        statements: 75,
        branches: 50,
        functions: 75,
      },
```

- [ ] **Step 4: Run coverage to verify the thresholds hold**

Run: `npm run coverage`

Expected: PASS with no threshold failure. If lines or functions fall short, add the missing case to `tests/detector.spec.ts` — that is the module with the most untested branches — rather than lowering the threshold.

- [ ] **Step 5: Format and commit**

```bash
npm run format
git add src/utils/matrix.js src/index.js vitest.config.ts
git commit -m "docs: correct the matrix helper and raise coverage thresholds

convertModelViewToThreeMatrix carried a TODO claiming conversion logic
was still to be determined. With artoolkit5-ts it is genuinely a no-op:
matrixGL is already 4x4 column-major right-handed. Documented as a
defensive copy and deprecated.

Detection logic now lives in a testable module, so thresholds go from 65
to 75 for lines, statements and functions.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Multi-pattern example

The end-to-end exercise of the family-aware registry, and the only place the real WASM path runs.

**Files:**

- Create: `examples/simple-marker/data/patt.kanji`
- Modify: `examples/simple-marker/index.html`
- Modify: `examples/simple-marker/README.md`

**Interfaces:**

- Consumes: `plugin.loadMarker(patternUrl, size)` and the `ar:marker*` events from Tasks 5-7.
- Produces: nothing consumed by code.

- [ ] **Step 1: Add the second pattern file**

```bash
curl -fsSL -o examples/simple-marker/data/patt.kanji \
  https://raw.githubusercontent.com/AR-js-org/AR.js/master/data/data/patt.kanji
head -c 60 examples/simple-marker/data/patt.kanji
```

Expected: a short run of space-separated integers. `.patt` files are ASCII.

- [ ] **Step 2: Load both patterns in `index.html`**

Replace the `loadMarkerBtn` click handler body with:

```js
const patterns = [
  { url: "/examples/simple-marker/data/patt.hiro", label: "hiro" },
  { url: "/examples/simple-marker/data/patt.kanji", label: "kanji" },
];

for (const { url, label } of patterns) {
  log(`Requesting loadMarker for ${label}`);
  const res = await plugin.loadMarker(url, 1);
  log(`${label} loaded: ${JSON.stringify(res)}`);
}
```

- [ ] **Step 3: Log the family and ID on every marker event**

Replace the marker event subscriptions with:

```js
plugin.core.eventBus.on("ar:markerFound", (e) =>
  log(`FOUND ${e.type}:${e.markerId} cf=${e.confidence.toFixed(2)}`),
);
plugin.core.eventBus.on("ar:markerUpdated", (e) =>
  log(`UPDATED ${e.type}:${e.markerId}`),
);
plugin.core.eventBus.on("ar:markerLost", (e) =>
  log(`LOST ${e.type}:${e.markerId}`),
);
```

If the existing file already subscribes to these events, edit those handlers in place rather than adding duplicates.

- [ ] **Step 4: Update the example README**

Add a section explaining that the example tracks two patterns, that each `loadMarker` call returns its own ID, and that every event carries both `markerId` and `type` because the two marker families have independent ID registries.

- [ ] **Step 5: Verify in a browser**

```bash
npm run build
npm run smoke:browser
```

Open `http://localhost:8080/examples/simple-marker/`, start the camera, click Load Marker. Expected: both patterns report loaded with distinct IDs; presenting a Hiro or Kanji marker logs `FOUND pattern:<id>`; removing it logs `LOST pattern:<id>` for that ID only.

This is the one manual verification step in the plan. Detection, WASM loading and the `ImageBitmap` path cannot be exercised in jsdom.

- [ ] **Step 6: Commit**

```bash
npm run format
git add examples/simple-marker/
git commit -m "docs: track two pattern markers in the example

Multiple patterns already worked - loadPattern dedups by URL and each
pattern gets its own ID - but nothing demonstrated it. Two markers make
the example an end-to-end exercise of the family-aware registry and
per-marker lost handling.

Events now log type and markerId together, matching how markers are
actually identified.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: README upgrade notes

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes: the final public API from Tasks 5-8.
- Produces: nothing consumed by code.

- [ ] **Step 1: Update the API documentation**

Bring the README's option table, event table and examples in line with the implementation: `wasmUrl` in place of `artoolkitModuleUrl`, the payloads `{ markerId, type, matrix, confidence, timestamp }`, `getMarkerState(markerId, type)`, and no `ar:getMarker` anywhere.

- [ ] **Step 2: Add an upgrade section**

````markdown
## Upgrading to 0.2.0

This release replaces the detection engine with
[artoolkit5-ts](https://github.com/AR-js-org/artoolkit5-ts) 0.2.0. It is a
breaking change.

**`ar:getMarker` is removed.** It exposed artoolkit5-js internals — `idPatt`,
`cfPatt`, `vertex` — that artoolkit5-ts does not produce. Use `ar:markerFound`,
`ar:markerUpdated` and `ar:markerLost`, which carry the same pose information in
a stable shape.

**Event payloads are renamed.** `id` becomes `markerId` and `poseMatrix` becomes
`matrix`, matching AR.js-next's documented contract. A new `type` field carries
the marker family.

```js
// Before
eventBus.on("ar:markerFound", ({ id, poseMatrix }) => {
  /* … */
});

// After
eventBus.on("ar:markerFound", ({ markerId, type, matrix }) => {
  /* … */
});
```

`arjs-plugin-threejs` already reads both spellings, so it keeps working without
changes.

**`corners` is no longer emitted.** The value shipped until now was malformed:
artoolkit5-js reports `vertex` as four `[x, y]` pairs, and the plugin unpacked
it as a flat array, producing two entries of two points each. No correct
consumer can have depended on it. Proper corner data returns once artoolkit5-ts
exposes `vertex` on `MarkerPose`.

**`getMarkerState` takes the marker family.**

```js
plugin.getMarkerState(3, "pattern");
```

Pattern and barcode markers have independent ID registries — both start at 0 —
so an ID alone does not identify a marker.

**`artoolkitModuleUrl` is renamed `wasmUrl`,** matching artoolkit5-ts's
`createARToolKitState`.

**Detection is browser-only.** It requires `Worker` and `OffscreenCanvas`. The
`worker_threads` path is removed; it never functioned. `worker: false` still
runs the plugin lifecycle under Node.

### Not yet supported

Barcode (matrix code) markers and `configureDetector` options are supported by
artoolkit5-ts 0.2.0 but not yet exposed here. `trackBarcode(barcodeId, size)` is
the reserved entry point for barcode markers, which need no file load. Both are
tracked as follow-up issues.
````

- [ ] **Step 3: Verify every documented name exists**

```bash
grep -rn "artoolkitModuleUrl\|poseMatrix\|ar:getMarker" README.md examples/ src/
```

Expected: matches only inside the README's "Before" upgrade example. Anything else is a stale reference to fix.

- [ ] **Step 4: Run the full verification pass**

```bash
npm run format:check
npm run lint
npm test
npm run coverage
npm run build
npm run smoke:node
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the 0.2.0 breaking changes and upgrade path

Covers the removal of ar:getMarker and corners, the markerId/matrix
rename, the type field, getMarkerState's second argument, the
artoolkitModuleUrl to wasmUrl rename, and browser-only detection.

Notes barcode markers and configureDetector as supported upstream but
not yet exposed, with trackBarcode reserved as the entry point.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the plan

File these as issues; they are out of scope here and each needs its own spec:

1. **`configureDetector` passthrough** plus the mixed pattern+barcode example. Detection mode, threshold mode, matrix code type, pattern ratio, and per-family `minConfidence` — which would replace the detector's own confidence filter.
2. **`trackBarcode(barcodeId, size)`** plus the barcode example. Purely additive: the registry, payloads and worker protocol already carry `type`.
3. **Merge `main` into `dev`** to recover the 0.1.3 release-workflow fixes. `dev` is at 0.1.2.
4. **Upstream, on `AR-js-org/artoolkit5-ts`:** expose `ARMarkerInfo.vertex` on `MarkerPose`. The data is already in the WASM heap and is never read out. Once released, re-add `corners` here as four `[x, y]` points.
