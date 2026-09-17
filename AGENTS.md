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
`{ id, type }`. These use `id` rather than `markerId` because they mirror
artoolkit5-ts's `MarkerPose` shape directly; the rename to `markerId` happens at
the event boundary in `plugin.js`.

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
