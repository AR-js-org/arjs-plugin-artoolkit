# Migrating the detection engine to artoolkit5-ts

**Date:** 2026-09-17
**Issue:** [#22](https://github.com/AR-js-org/arjs-plugin-artoolkit/issues/22)
**Branch:** `feat/artoolkit5-ts-migration` (off `dev`)
**Status:** Approved, ready for implementation planning

## Context

`arjs-plugin-artoolkit` is the marker-detection plugin for AR.js-next. It
currently depends on `@ar-js-org/artoolkit5-js@^0.3.2`, a class-based library
that conflates WASM state, marker tracking and DOM concerns behind an
`ARController` with an event-emitter API.

`@ar-js-org/artoolkit5-ts` 0.2.0 shipped on 2026-09-17. It is a data-oriented
replacement: plain `ARToolKitState` data, pure functions, no DOM, no classes,
Worker-friendly by construction.

Issue #22 was written against a pre-0.1 artoolkit5-ts. Three of its predictions
hold: `matrixGL` is a `Float32Array(16)`, `processFrame` returns detected and
lost markers, and `ImageBitmap` input needs converting to RGBA pixels via
`OffscreenCanvas`. Five things postdate the issue and change the design:

1. Barcode (matrix code) markers exist, via `trackBarcodeMarker`.
2. Pattern and barcode markers have **independent ID registries**.
3. `configureDetector` exposes typed detection options.
4. `minConfidence` filtering moved into the library, per family.
5. Lost markers are reported by the library, per family, on the frame they
   disappear.

There is no event emitter anywhere in artoolkit5-ts. The plugin's
`ar:getMarker` event has no foundation under the new library.

## Goals

- Replace artoolkit5-js with artoolkit5-ts 0.2.0 for pattern-marker detection.
- Align the plugin's event payloads with AR.js-next's documented contract.
- Make the detection logic unit-testable without a Worker.
- Demonstrate multi-marker tracking in the example.
- Add agent instruction files so every coding agent working in this repo shares
  one description of the architecture and conventions.

## Non-goals

Deferred to their own issues, each with its own spec:

- `configureDetector` passthrough (detection mode, threshold, pattern ratio) and
  the mixed pattern+barcode example.
- `trackBarcodeMarker` support and the barcode example.
- Merging `main` into `dev` to recover the 0.1.3 release-workflow fixes.

## Decisions

| Decision            | Choice                                                             | Rationale                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Architecture        | Extract a DOM-free detector core; worker becomes a message pump    | Makes detection logic unit-testable; `src/worker/**` is currently excluded from coverage because it cannot run outside a Worker                  |
| `ar:getMarker`      | Removed                                                            | It exposed artoolkit5-js internals (`idPatt`, `cfPatt`, `vertex`) that artoolkit5-ts does not produce; synthesising it would mean inventing data |
| Event payload       | `{ markerId, type, matrix, confidence, timestamp }`                | Matches AR.js-next's documented contract; today's `{ id, poseMatrix }` only works because arjs-plugin-threejs defensively tries both spellings   |
| Marker registry key | `type` and `id` combined into one string key                       | Pattern and barcode IDs are independent registries; both start at 0                                                                              |
| Lost markers        | Library `lost[]` is primary; interval sweep demoted to stall guard | The library cannot report a loss when frames stop arriving at all                                                                                |
| Node/worker_threads | Removed                                                            | The branch never worked: the worker uses `self.addEventListener` and `OffscreenCanvas`                                                           |
| Examples            | Multi-pattern now; barcode and mixed with their own issues         | Each example ships with the API it needs                                                                                                         |

## Architecture

```
src/
  index.js                    public exports
  plugin.js                   lifecycle, marker registry, event emission
  detector/
    artoolkit-detector.js     NEW - DOM-free wrapper over artoolkit5-ts
  worker/
    worker.js                 message pump + ImageBitmap -> pixels
  utils/matrix.js             unchanged file, corrected documentation
```

### The detector core

```js
createDetector({ cameraParametersUrl, wasmUrl, width, height, minConfidence })
  -> Promise<Detector>

detector.loadPattern(url, size)   -> Promise<number>      // deduped by URL
detector.detect(pixels)           -> { detected, lost }   // Uint8ClampedArray
detector.dispose()                -> void
```

The detector owns the `ARToolKitState`, the pattern-URL dedup map, and the lazy
initialisation with exponential backoff (moved out of the worker so it can be
tested). It references no `self`, no `OffscreenCanvas`, and no `postMessage`, so
it runs under plain vitest/jsdom against a mocked artoolkit5-ts.

`detect()` passes the library's `FrameResult` through unchanged apart from the
`minConfidence` filter, which preserves today's behaviour until the
`configureDetector` issue moves it into the library.

### What the worker keeps

Receiving messages, converting `ImageBitmap` to RGBA pixels through an
`OffscreenCanvas` sized to the frame, calling the detector, and posting results
back. Nothing else.

### What is deleted, not ported

`serializeGetMarkerEvent`, `shouldForwardGetMarker`, `attachGetMarkerForwarder`,
`PATTERN_MARKER_TYPE`, the module-level `MIN_CONFIDENCE` gate, and the
`worker_threads` branch in `_startWorker` / `_stopWorker` along with the dual
`addEventListener` / `on` handling. Approximately 150 lines.

## Worker message protocol

| Direction      | Message            | Payload                                                          |
| -------------- | ------------------ | ---------------------------------------------------------------- |
| main to worker | `init`             | `{ cameraParametersUrl, wasmUrl, width, height, minConfidence }` |
| main to worker | `loadMarker`       | `{ patternUrl, size, requestId }`                                |
| main to worker | `processFrame`     | `{ frameId, imageBitmap, width, height }`                        |
| main to worker | `dispose`          | none                                                             |
| worker to main | `ready`            | none                                                             |
| worker to main | `loadMarkerResult` | `{ ok, markerId, size, requestId, error }`                       |
| worker to main | `detectionResult`  | `{ frameId, detected, lost }`                                    |
| worker to main | `error`            | `{ message }`                                                    |

`detected` entries are `{ id, type, confidence, matrixGL }`. `lost` entries are
`{ id, type }`.

`MarkerPose.matrix` (the `Float64Array` 3x4 row-major native pose) is **not**
forwarded. Nothing downstream reads it and it costs 128 bytes per marker per
frame across the thread boundary.

The `artoolkitModuleUrl` option is renamed `wasmUrl`, matching
`createARToolKitState`'s actual parameter.

The `dispose` message is new: it lets `disposeARToolKitState` run and release
WASM resources before the worker is terminated.

### Post-implementation note: unbounded queueing under camera-rate load

The design above sent `detectionResult` only when the worker had something to
report (`if (detected.length || lost.length)`). That was found to cause
unbounded queueing once real hardware exercised it at camera frame rate.
`postMessage` delivers to a single FIFO queue per worker; skipping the
acknowledgement for frames with nothing to report meant the plugin had no
signal that a frame had finished, so `_onEngineUpdate` kept posting one
`processFrame` per `engine:update` with no regard for whether the worker was
still processing the previous one. Once `detect()` took longer than the frame
interval — which real pattern matching at 60fps does — the backlog grew
without bound, and every later message, including `loadMarker`, queued behind
it.

Reproduced against the commit this migration shipped, varying only the frame
rate: 212 frames pumped at a 33ms interval let a concurrent `loadMarker`
resolve in 46ms; 930 frames at a 4ms interval delayed it past its 10-second
client-side timeout. The `loadMarkerResult` that would have resolved it
arrived after the timeout had already deleted the pending entry, so the
resolution was silently dropped, and — because the `simple-marker` example
awaits each `loadMarker` in sequence — the rejection threw before the second
marker was ever requested.

Fixed by replacing the guard with two changes, not a bigger timeout:

1. The worker now posts exactly one `detectionResult` per `processFrame`
   received, unconditionally — including empty results and the frames it
   skips outright (no `ImageBitmap`, or the detector not yet constructed).
2. `src/plugin.js` tracks a single in-flight frame (`_frameInFlight`) and
   drops — closing the `ImageBitmap` of — any `engine:update` that arrives
   before the previous frame's acknowledgement, rather than queueing it. The
   flag is cleared by `detectionResult` or `error`, and reset in
   `_stopWorker` so a restarted worker is not born blocked.

Dropping is correct for real-time vision: the newest frame is the one worth a
pose, and a queued backlog only adds latency to a pose that is already stale
by the time it is computed. `AGENTS.md`'s worker message protocol section
carries the corrected, current description of when `detectionResult` is sent
and of the in-flight gate; this note records only the history.

## Event contract

| Event              | Payload                                             |
| ------------------ | --------------------------------------------------- |
| `ar:markerFound`   | `{ markerId, type, matrix, confidence, timestamp }` |
| `ar:markerUpdated` | `{ markerId, type, matrix, confidence, timestamp }` |
| `ar:markerLost`    | `{ markerId, type, timestamp }`                     |
| `ar:workerReady`   | `{}`                                                |
| `ar:workerError`   | `{ message }`                                       |

`matrix` is `matrixGL` passed through unchanged: 4x4 column-major right-handed,
already WebGL-ready.

`corners` is dropped, and it is worth recording that this removes nothing that
ever worked.

artoolkit5-js documents `markerInfo.vertex` as nested — `[[x,y],[x,y],[x,y],[x,y]]`,
length 4 — and consumes it that way in `drawDebugMarker` (`vertex[0][0]`,
`vertex[0][1]`). The worker forwards it unchanged, but `plugin.js` unpacks it as
if it were flat:

```js
for (let i = 0; i + 1 < v.length; i += 2) {
  corners.push([v[i], v[i + 1]]);
}
```

Against a 4-element nested array that produces two entries, each a pair of
points, rather than four corners. Consumers have been receiving a malformed
value. Nothing reads it — `corners` has no occurrences in `arjs-plugin-threejs`
source or in AR.js-next examples once vendored bundles and minified `dist`
output are excluded — which is why the defect went unnoticed.

Corner data is genuinely useful for debug overlays, marker outlines,
hit-testing and occlusion masks, so this is a deferral rather than a rejection.
The data exists in the WASM heap as `ARMarkerInfo.vertex`; artoolkit5-ts simply
never reads it out, and has no reference to `vertex`, `corners` or `pos`
anywhere in its source. An upstream issue asks for `vertex` on `MarkerPose`;
once it lands, the plugin re-adds `corners` correctly as four `[x, y]` points.
Shipping a field we cannot populate, or preserving a broken one, both seem worse
than removing it and fixing it at the source.

`convertModelViewToThreeMatrix` remains exported. Its `TODO` comment is replaced
with accurate documentation: it returns a defensive copy, and no coordinate
conversion is required for `matrixGL` input. It is marked deprecated.

## Marker registry

The registry is a `Map` keyed by the marker's family and ID combined into a
single string, rather than by the numeric ID alone.

Pattern IDs are assigned sequentially by the engine; barcode IDs are encoded in
the marker itself. Both families start at 0, so a bare numeric key would make
pattern marker 3 and barcode marker 3 indistinguishable.

The consequences are concrete, not theoretical. `arjs-plugin-threejs` keys its
`THREE.Group` anchors on the stringified marker ID, so two colliding markers
would share one anchor: their poses would overwrite each other every frame,
`markerFound` would never fire for the second marker, and a `markerLost` for
either would hide the model on the marker still in view.

artoolkit5-ts already made this decision. Its `LostMarker` type carries `type`
alongside `id` specifically so the family is never ambiguous. Keying on `id`
alone would discard the disambiguator the library provides.

Barcode markers are out of scope for this migration, but the key format and the
`type` field ship now: the event payload is public API, and adding `type` later
would be a second breaking change for consumers.

## Lifecycle and the dimensions fix

The current worker calls `initArtoolkit(640, 480)` from the `loadMarker` path
with hardcoded dimensions, while `processFrame` calls it with the real frame
size. `createARToolKitState(width, height, cameraUrl)` fixes dimensions at
creation, so loading markers before the first frame arrives — the natural
multi-marker flow — builds state at 640x480 and then detects a differently sized
feed against the wrong intrinsics.

Fix: the `init` message carries the real frame dimensions, and state creation is
deferred until dimensions are known. `loadMarker` awaits readiness rather than
forcing initialisation at a guessed size.

### Post-implementation note

The `init`-carries-dimensions half of this fix turned out to be
unimplementable: at `_startWorker()` time (`src/plugin.js`) no frame has
arrived yet, so there are no real dimensions to send, and the plugin exposes
no `width`/`height` option to manufacture them from. The half that shipped is
the deferral — the detector is constructed on `init` but stays dimension-less
until the first `processFrame` message, which is when real dimensions become
known and `createARToolKitState` fixes them permanently. That alone fixes the
wrong-intrinsics bug this section describes, since `loadMarker()` only awaits
readiness rather than forcing initialisation at a guessed size. `AGENTS.md`'s
worker-protocol table was corrected to drop `width, height` from `init`'s
payload and documents the frame-triggered initialisation instead.

## Examples

`examples/simple-marker/` is upgraded to load two pattern markers (`patt.hiro`
and `patt.kanji`, the latter added to `data/`), each driving its own anchor. It
demonstrates the intended flow explicitly:

```js
await plugin.enable();
const hiro = await plugin.loadMarker("./data/patt.hiro", 1);
const kanji = await plugin.loadMarker("./data/patt.kanji", 1);
```

Multiple pattern markers already work today — `loadPatternOnce` dedups by URL
and assigns each pattern its own ID — but nothing demonstrates or tests it. With
two markers in play the example becomes the end-to-end exercise of the
family-aware registry and per-marker lost handling.

`trackBarcode(barcodeId, size)` is reserved and documented as the planned
sibling entry point for barcode markers, which need no file load. It is not
implemented here. Naming it now keeps the barcode issue purely additive instead
of forcing a third breaking change to the public surface.

## Agent instruction files

`AGENTS.md` is the single source of truth. It is the cross-tool convention read
natively by Antigravity, Codex, Cursor and Zed, and covers:

- What the plugin is and how it fits into AR.js-next
- Commands: `npm test`, `npm run build`, `npm run format`, `npm run lint`,
  `npm run smoke:node`
- The three-module architecture (plugin / detector / worker)
- The worker message protocol and the event contract
- Conventions: ESM, JSDoc on public API, prettier, husky pre-commit
- The artoolkit5-ts dependency and the state of this migration
- Branch flow: feature branch to `dev` to `main`
- Git identity: never pass `--author`; let the repository's config decide

Pointer files, because these tools do not read `AGENTS.md`:

| File                              | Content                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `CLAUDE.md`                       | An `@AGENTS.md` include plus the superpowers workflow                      |
| `GEMINI.md`                       | Pointer to `AGENTS.md`                                                     |
| `.github/copilot-instructions.md` | Pointer plus an inline summary, since Copilot does not follow `@`-includes |

## Testing strategy

Test-driven: each behaviour gets a failing test before its implementation.

| File                                                                                     | Covers                                                                                                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tests/detector.spec.ts` (new)                                                           | Detector core against a mocked artoolkit5-ts: pixels to poses, `loadPattern` dedup, `minConfidence` filter, init backoff, dispose |
| `tests/plugin.markers.spec.ts` (new)                                                     | Pattern 3 and barcode 3 tracked independently: separate found/lost, no cross-talk                                                 |
| `tests/plugin.events.spec.ts` (new)                                                      | Payload shape `{ markerId, type, matrix, confidence, timestamp }`; asserts `ar:getMarker` is never emitted                        |
| `tests/plugin.stall.spec.ts` (new)                                                       | Fake timers: the sweep emits `markerLost` when frames stop arriving                                                               |
| `tests/plugin.spec.ts`, `plugin.more.spec.ts`, `plugin.extra.spec.ts`, `version.spec.ts` | Updated for renamed payload fields and the removed `ar:getMarker`                                                                 |

`vitest.config.ts` keeps `src/worker/**` on the coverage exclude list — it is a
message pump with no logic worth asserting. The detector module needs no config
change to be counted: the existing `src/**/*.js` include already covers it, and
it is deliberately not added to the exclude list. The logic that was previously
untestable becomes the best-covered file. The only config edit is raising the
coverage thresholds from 65 to 75 for lines, statements and functions; the
branches threshold stays at 50.

Marker-family independence is tested by driving the plugin's `detectionResult`
handler directly with both families present. It does not require barcode support
to be implemented, only that the registry and payloads carry `type`.

## Dependencies and build

- Remove `@ar-js-org/artoolkit5-js@^0.3.2`
- Add `@ar-js-org/artoolkit5-ts@^0.2.0`, which pulls in
  `@ar-js-org/artoolkit5-wasm`

The artoolkit5-ts README pins the WASM package at `^0.3.0` while the 0.2.0
release notes say it was bumped to `^0.2.0`. Verify the resolved version during
implementation and report the discrepancy upstream if it is a documentation bug.

`vite.config.ts` and `tsconfig.json` need no structural change. The worker build
already targets ES modules.

## Consumer migration notes

For the README's upgrade section. This is a breaking release:

1. `ar:getMarker` is removed. Use `ar:markerFound` / `ar:markerUpdated` /
   `ar:markerLost`, which carry the same pose information in a stable shape.
2. Event payloads rename `id` to `markerId` and `poseMatrix` to `matrix`, and
   add `type`. `arjs-plugin-threejs` already reads both spellings, so it keeps
   working without changes.
3. `corners` is no longer emitted. The value shipped until now was malformed —
   nested vertex data unpacked as if it were flat — so no correct consumer can
   have depended on it. Proper corner data returns once artoolkit5-ts exposes
   `vertex`.
4. The `artoolkitModuleUrl` option is renamed `wasmUrl`.
5. Worker-based detection is browser-only and documented as such.
   `worker: false` still runs in Node for lifecycle testing.

## Follow-up issues to file

1. `configureDetector` passthrough plus the mixed pattern+barcode example.
2. `trackBarcode(barcodeId, size)` plus the barcode example.
3. Merge `main` into `dev` to recover the 0.1.3 release-workflow fixes
   (`dev` is at 0.1.2).
4. Upstream, on `AR-js-org/artoolkit5-ts`: expose `ARMarkerInfo.vertex` on
   `MarkerPose` so marker corners are available to consumers. Once released,
   re-add `corners` to this plugin's event payloads as four `[x, y]` points.
