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
npm run lint          # eslint (flat config in eslint.config.js)
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

| Direction     | Message              | Payload                                                            |
| ------------- | -------------------- | ------------------------------------------------------------------ |
| main → worker | `init`               | `{ cameraParametersUrl, wasmUrl, minConfidence, detectorOptions }` |
| main → worker | `loadMarker`         | `{ patternUrl, size, requestId }`                                  |
| main → worker | `trackBarcode`       | `{ barcodeId, size, requestId }`                                   |
| main → worker | `configure`          | `{ opts, requestId }`                                              |
| main → worker | `processFrame`       | `{ frameId, imageBitmap, width, height }`                          |
| main → worker | `dispose`            | none                                                               |
| worker → main | `ready`              | none                                                               |
| worker → main | `loadMarkerResult`   | `{ ok, markerId, size, requestId, error }`                         |
| worker → main | `trackBarcodeResult` | `{ ok, markerId, size, detectionMode, requestId, error }`          |
| worker → main | `configureResult`    | `{ ok, config, requestId, error }`                                 |
| worker → main | `detectionResult`    | `{ frameId, detected, lost }`                                      |
| worker → main | `initError`          | `{ message }`                                                      |
| worker → main | `error`              | `{ message }`                                                      |

`initError` and `error` both become `ar:workerError`, but only `error`
acknowledges the frame in flight. `initError` is posted from inside
`ensureReady` while the same frame goes on to its own `detectionResult`, so
treating it as an acknowledgement would let two frames into flight.

Requests carrying a `requestId` go through `plugin._request`, which resolves
with the `*Result` payload minus `ok`/`requestId`, or rejects on `ok: false`
or after 10 s.

`trackBarcode` and `configure` can be sent before readiness: the detector
queues them and runs them, in order, when the state is created, after the
construction options. The worker replies only once that has happened, so the
`*Result` reports whether the request was actually accepted, and a request
made before the first frame waits for it (subject to the 10 s timeout).
Readiness is published only after all of it has run, so nothing waiting on it
sees a half-configured engine. `trackBarcode` switches the mode to a
matrix-capable one if needed, since barcodes are only detected in one.

Options are applied one key at a time, because artoolkit5-ts's
`configureDetector` stops at the first invalid key and leaves the earlier ones
applied. A refused key fails alone and stays out of the recorded
configuration; a refused construction option does not stop queued requests.
`minConfidence` merges per family.

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

Both fields are **well-formed or absent, never malformed**. `_applyDetections`
checks them before emitting - `usableVertex` requires an array of four, and
`usableDir` an integer 0 to 3 - and nothing is fabricated, so a detection that
arrives without them emits with the keys present and the values `undefined`. The
keys never disappear, which is what keeps this table accurate and the payload one
shape across a per-frame path.

In practice every real detection carries both: `vertex` needs artoolkit5-ts 0.2.1,
`dir` needs 0.3.0, and `package.json` requires `^0.3.0`. The guards exist for the
paths the range cannot cover - a detection injected in a test, a stale
`node_modules`, a hand-built bundle - and because this function already normalises
every other field it emits, so these two passing through raw was the anomaly.

`dir` is range-checked rather than only type-checked for a specific reason: a
negative value would make `(4 - dir) % 4` a valid index to the _wrong_ corner,
failing silently instead of loudly.

`matrix` is a `Float32Array(16)`, 4x4 column-major right-handed, ready for
WebGL and for `THREE.Matrix4.fromArray()`. It needs no conversion.

`type` is `"pattern"` or `"barcode"`. Pattern and barcode markers have
**independent ID registries** in artoolkit5-ts — both start at 0 — so the
plugin's internal registry is keyed `` `${type}:${id}` ``, never by ID alone.
Anything keyed on the bare ID will make pattern 3 and barcode 3 collide.

`ar:markerLost` is debounced, not immediate. The detector routinely fails to
report a well-tracked marker on an isolated frame — angle, motion blur,
lighting — so `_applyMisses` requires `lostThreshold` **consecutive processed
frames** without a marker before it fires. Each registry entry carries a
`consecutiveMisses` counter that `_applyMisses` increments for every tracked
marker absent from a frame's `detected`, and `_applyDetections` resets to 0 on
any sighting. While a marker is within that tolerance it stays in the registry
and nothing is emitted; a re-detection during the window emits
`ar:markerUpdated`, not `ar:markerFound`. Only once the counter reaches
`lostThreshold` is the entry removed and `ar:markerLost` emitted, so a later
detection correctly starts over with `ar:markerFound`.

The counter keys on **absence from `detected`, not on the `lost` list**.
artoolkit5-ts reports a loss exactly once, on the frame the marker
disappears; counting `lost` entries (as 0.2.0 did) never got past 1, so loss
silently fell through to the sweep timer (#38). The worker still forwards
`lost`, but the plugin does not need it.

`_sweepMarkers` is a stall guard only: it reports every tracked marker lost
when **no frame** has been acknowledged for `lostThreshold × frameDurationMs`
(`_lastFrameAt`). It measures the pipeline, not the marker, so a slow but live
pipeline never trips it.

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
tested. Its **message shapes** are still pinned by `tests/worker.spec.ts`,
which imports the real worker with the detector and `self` stubbed; when you
add or change a message, update that spec and the protocol table above
together.

## Dependencies

`@ar-js-org/artoolkit5-ts` provides detection. It is data-oriented: plain
`ARToolKitState`, pure functions, no classes, no DOM, no event emitter. The
functions used here are `createARToolKitState`, `disposeARToolKitState`,
`loadPatternMarker`, `trackMarker`, `trackBarcodeMarker`, `configureDetector`
and `processFrame`. Confidence filtering is done by `processFrame` from the
per-family `minConfidence` given to `configureDetector`; the detector does not
filter again.

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

- Branch flow: feature branch → `dev` → `main`. Never commit directly to `main`;
  the hook in `.claude/settings.json` refuses `git commit`/`git push` there.
- Releases (milestones, tagging order, trusted publishing) follow
  `MAINTAINERS.md`.
- `.claude/settings.json` also runs prettier and eslint `--fix` on every file
  an agent edits (`.claude/hooks/format-on-edit.mjs`).
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
- A PR with a user-visible change adds an entry under `## [Unreleased]` in
  `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
  groups; mark breaking changes **Breaking** and say what consumers must
  change). Internal-only changes (tests, CI, refactors) need none. At release,
  `[Unreleased]` becomes the new version's section and its compare link is
  added.
