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
npm run lint          # eslint (currently non-functional: no flat config yet; see follow-up issue)
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

| Direction     | Message            | Payload                                           |
| ------------- | ------------------ | ------------------------------------------------- |
| main → worker | `init`             | `{ cameraParametersUrl, wasmUrl, minConfidence }` |
| main → worker | `loadMarker`       | `{ patternUrl, size, requestId }`                 |
| main → worker | `processFrame`     | `{ frameId, imageBitmap, width, height }`         |
| main → worker | `dispose`          | none                                              |
| worker → main | `ready`            | none                                              |
| worker → main | `loadMarkerResult` | `{ ok, markerId, size, requestId, error }`        |
| worker → main | `detectionResult`  | `{ frameId, detected, lost }`                     |
| worker → main | `error`            | `{ message }`                                     |

`detected` entries are `{ id, type, confidence, matrixGL, vertex, dir }`; `lost` entries are
`{ id, type }`. These use `id` rather than `markerId` because they mirror
artoolkit5-ts's `MarkerPose` shape directly; the rename to `markerId` happens at
the event boundary in `plugin.js`.

`init` carries no frame dimensions: none exist yet at `_startWorker()` time.
The detector is constructed on `init` but stays dimension-less until the
first `processFrame` message, which is when real dimensions become known and
`createARToolKitState` can fix them permanently. This is why `loadMarker()`
must be called only after at least one frame has reached the worker.

`detectionResult` is sent exactly once per `processFrame` received, always —
including when both `detected` and `lost` are empty, and for a frame the
worker skips outright (no `ImageBitmap` on the payload, or the detector not
yet constructed). This acknowledgement is load-bearing, not a courtesy:
`src/plugin.js` allows only one frame in flight at a time and relies on it
arriving to release the next one (see `_onEngineUpdate` and
`_onWorkerMessage`). A `processFrame` that went unacknowledged would wedge
frame submission permanently. An earlier version sent `detectionResult` only
when there was something to report; see the "Post-implementation note" in
`docs/superpowers/specs/2026-09-17-artoolkit5-ts-migration-design.md` for why
that broke under real camera-rate load.

At most one frame is ever in flight between the plugin and the worker.
`_onEngineUpdate` drops — and closes the `ImageBitmap` of — any `engine:update`
that arrives while the previous frame's `detectionResult`/`error` is still
outstanding, rather than queueing it. `postMessage`'s per-worker queue is FIFO
and unbounded, so with no backpressure a worker that falls behind the camera's
frame rate accumulates an unbounded backlog, and every later message —
including `loadMarker` — waits behind it. Dropping is deliberate: the newest
frame is the one worth a pose, and a queued backlog only adds latency to a
pose that is already stale by the time it is computed.

## Event contract

| Event              | Payload                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `ar:markerFound`   | `{ markerId, type, matrix, confidence, vertex, dir, timestamp }` |
| `ar:markerUpdated` | `{ markerId, type, matrix, confidence, vertex, dir, timestamp }` |
| `ar:markerLost`    | `{ markerId, type, timestamp }`                                  |
| `ar:workerReady`   | `{}`                                                             |
| `ar:workerError`   | `{ message }`                                                    |

`vertex` is the detected square's four corners, `[[x, y], …]`, in the pixel
coordinates of the frame that was submitted — not of however the video is
displayed. Those differ whenever the video element is rendered at anything
other than its native size, which is the usual case; `examples/simple-marker/`
shows the scaling. Corners are enough to outline a marker, hit-test it or mask
it without touching the pose matrix, which is the point of the field. Unlike
`matrix` it is freshly allocated per frame, so consumers may retain it.

`dir` is the marker's rotation, 0 to 3, and is what makes `vertex` order
interpretable. Corner order follows ARToolKit's square tracer rather than the
printed marker, so `vertex[0]` lands on a different physical corner as the
marker turns. The marker's own top-left is `vertex[(4 - dir) % 4]`, and the
other three clockwise from there as `(5 - dir) % 4`, `(6 - dir) % 4`,
`(7 - dir) % 4` — ARToolKit's own mapping, the one it feeds its pose solver.
Outlining or hit-testing needs none of this, since any order traces the same
quadrilateral; it matters when a specific printed corner must be identified.
`examples/simple-marker/` marks that corner, which is the visible difference.

Both fields are always present: `vertex` needs artoolkit5-ts 0.2.1 and `dir`
needs 0.3.0, and `package.json` requires `^0.3.0`, so neither is optional in
practice. Earlier versions are excluded by the range rather than tolerated at
runtime.

`matrix` is a `Float32Array(16)`, 4x4 column-major right-handed, ready for
WebGL and for `THREE.Matrix4.fromArray()`. It needs no conversion.

`type` is `"pattern"` or `"barcode"`. Pattern and barcode markers have
**independent ID registries** in artoolkit5-ts — both start at 0 — so the
plugin's internal registry is keyed `` `${type}:${id}` ``, never by ID alone.
Anything keyed on the bare ID will make pattern 3 and barcode 3 collide.

`ar:markerLost` is debounced, not immediate. The detector routinely fails to
report a well-tracked marker on an isolated frame — angle, motion blur,
lighting — so `_applyLost` requires `lostThreshold` **consecutive** frames of
the library reporting a marker missing before it fires. Each registry entry
carries a `consecutiveMisses` counter that `_applyLost` increments and
`_applyDetections` resets to 0 on any sighting. While a marker is within that
tolerance it stays in the registry and nothing is emitted; a re-detection
during the window emits `ar:markerUpdated`, not `ar:markerFound`, since the
marker never left as far as consumers are concerned. Only once the counter
reaches `lostThreshold` is the entry removed and `ar:markerLost` emitted, so a
later detection correctly starts over with `ar:markerFound`. This is separate
from `_sweepMarkers`, which covers frames that stop arriving at all (see the
"Lost markers" row of the Decisions table and its "Post-implementation note"
in `docs/superpowers/specs/2026-09-17-artoolkit5-ts-migration-design.md`).

## Conventions

- ESM only. `"type": "module"`; no `require`.
- JSDoc on every exported function, class and public method.
- prettier formats everything; run `npm run format` before committing.
- husky runs on commit. `HUSKY=0` disables it in CI.

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
`loadPatternMarker`, `trackMarker` and `processFrame`. `trackBarcodeMarker`
exists in the library but is reserved for the barcode follow-up (see
Non-goals in the migration spec) — it is not imported anywhere in this
plugin.

## Commits

Every commit follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer]
```

Types used in this repository: `feat`, `fix`, `docs`, `chore`, `refactor`,
`test`, `ci`, `perf`. Description in the imperative, lower case, no trailing
period.

Breaking changes take `!` after the type and a `BREAKING CHANGE:` footer saying
what consumers must change:

```
feat!: rename marker event payload fields

BREAKING CHANGE: `id` becomes `markerId` and `poseMatrix` becomes `matrix`.
```

Commits predating this convention do not follow it; it applies going forward.

## Git

- Branch flow: feature branch → `dev` → `main`. Never commit directly to `main`.
- **Never pass `--author` or `-c user.name=…` to `git commit`.** Let the
  repository's own git config decide authorship. Overriding it has previously
  misattributed commits to the wrong GitHub account, and undoing that costs a
  `filter-branch` plus a force-push.

## Pull requests

- **Branch from `dev`, never from `main`:** `git checkout -b feat/<short-name> dev`
- **Open every PR against `dev`.** `main` receives changes only by merging `dev`
  at release time, never directly from a feature branch.
- PR titles follow the same conventional-commit format as commit subjects.
- Keep a PR to one logical change. If a branch grows a second concern, split it.
