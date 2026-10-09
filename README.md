# 🎯 arjs-plugin-artoolkit ⚡🕶️

[![GitHub stars](https://img.shields.io/github/stars/ar-js-org/arjs-plugin-artoolkit?style=flat-square)](https://github.com/ar-js-org/arjs-plugin-artoolkit/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/ar-js-org/arjs-plugin-artoolkit?style=flat-square)](https://github.com/ar-js-org/arjs-plugin-artoolkit/network/members)
[![CI](https://github.com/ar-js-org/arjs-plugin-artoolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/ar-js-org/arjs-plugin-artoolkit/actions)
[![Build](https://github.com/ar-js-org/arjs-plugin-artoolkit/actions/workflows/build.yml/badge.svg)](https://github.com/ar-js-org/arjs-plugin-artoolkit/actions)
[![npm version](https://img.shields.io/npm/v/@ar-js-org/arjs-plugin-artoolkit?style=flat-square)](https://www.npmjs.com/package/@ar-js-org/arjs-plugin-artoolkit)
[![Types](https://img.shields.io/badge/Types-included-blue?style=flat-square)](https://github.com/ar-js-org/arjs-plugin-artoolkit/blob/main/types/index.d.ts)
[![Prettier](https://img.shields.io/badge/Prettier-enabled-2b7489?style=flat-square)](https://prettier.io/)
[![License](https://img.shields.io/github/license/ar-js-org/arjs-plugin-artoolkit?style=flat-square)](https://github.com/ar-js-org/arjs-plugin-artoolkit/blob/main/LICENSE)
[![Coverage](https://img.shields.io/codecov/c/gh/ar-js-org/arjs-plugin-artoolkit?style=flat-square)](https://codecov.io/gh/ar-js-org/arjs-plugin-artoolkit)

Lightweight WebWorker ARToolKit plugin for AR.js that detects square markers using WebAssembly and ImageBitmap zero-copy transfers, offering an event-driven API for realtime camera input, fast detection, and easy integration. 🔎🎯🚀⚡🧩

## Table of Contents

- [Features](#features-)
- [Version](#version-)
- [Changelog](https://github.com/AR-js-org/arjs-plugin-artoolkit/blob/main/CHANGELOG.md)
- [Upgrading to 0.3.0](#upgrading-to-030-)
- [Upgrading to 0.2.0](#upgrading-to-020-)
- [Installation](#installation-)
- [Using the ESM build (recommended)](#using-the-esm-build-recommended-)
- [Using source (development mode)](#using-source-development-mode-)
- [Usage](#usage-)
  - [Quick Start (copy-paste)](#quick-start-copy-paste-)
  - [Register and enable](#register-and-enable-)
  - [Events](#events-)
  - [Sending frames](#sending-frames-)
  - [Loading a pattern marker](#loading-a-pattern-marker-)
  - [Tracking a barcode marker](#tracking-a-barcode-marker-)
  - [Configuring the detector](#configuring-the-detector-)
- [Examples](#examples-)
- [API Reference](#api-reference-)
- [Troubleshooting](#troubleshooting-)

<a id="features-"></a>

## Features ✨🧭

- 🧠 Web Worker-based detection — marker detection runs off the main thread (Browser Module Worker)
- 🖼️ ImageBitmap support — zero-copy frame transfer for efficient camera frames
- 🧩 ARToolKit integration — square pattern markers (patt files) and barcode (matrix code) markers, powered by [artoolkit5-ts](https://github.com/AR-js-org/artoolkit5-ts)
- ⚡ Event-driven API — `ar:markerFound` / `ar:markerUpdated` / `ar:markerLost` carrying `{ markerId, type, matrix, confidence, timestamp }`
- 🔍 Confidence filtering — detections below `minConfidence` (default 0.6, settable per marker family) are dropped before they reach any event listener
- 🎛️ Detector tuning — detection mode, barcode dictionary, thresholding and more, at construction or at runtime

<a id="version-"></a>

## Version 🏷️

The plugin exposes its build-time version both as a constant and on each instance:

```js
import {
  ArtoolkitPlugin,
  ARTOOLKIT_PLUGIN_VERSION,
} from "@ar-js-org/arjs-plugin-artoolkit";

console.log("Build version:", ARTOOLKIT_PLUGIN_VERSION); // e.g. 0.1.0 or 'unknown'
const plugin = new ArtoolkitPlugin();
console.log("Instance version:", plugin.version);
```

If the build-time define is missing (for example when using raw source or some test runners), the version falls back to `'unknown'`.

What changed in each release, including every breaking change, is in
[CHANGELOG.md](https://github.com/AR-js-org/arjs-plugin-artoolkit/blob/main/CHANGELOG.md).

<a id="upgrading-to-030-"></a>

## Upgrading to 0.3.0 🔄

No breaking API changes. New:

- **Barcode markers:** `plugin.trackBarcode(barcodeId, size)`. See
  [Tracking a barcode marker](#tracking-a-barcode-marker-).
- **Detector options:** `detectionMode`, `matrixCodeType` and `detector` in
  the constructor, and `plugin.configureDetector(opts)` at runtime. See
  [Configuring the detector](#configuring-the-detector-).
- **`minConfidence` accepts `{ pattern, barcode }`.** A number still applies
  to both families. Filtering now happens inside artoolkit5-ts.

Behaviour changes worth knowing:

- **`ar:markerLost` now honours `lostThreshold` as a frame count.** In 0.2.0
  loss was in practice a 1-second timer (`lostThreshold × frameDurationMs`),
  because artoolkit5-ts reports a loss only once and the miss counter never
  advanced. Now every processed frame without the marker counts as a miss, so
  a marker is lost after `lostThreshold` consecutive frames without it,
  whatever the frame rate. `frameDurationMs` only sizes the stall guard, which
  reports all markers lost when frames stop being processed at all.
- **A failed WASM or camera-parameter load fires `ar:workerError` at once**,
  with the underlying message, instead of surfacing only as a
  `loadMarker request timed out` ten seconds later. Initialisation still
  retries in the background.

<a id="upgrading-to-020-"></a>

## Upgrading to 0.2.0 🔄

This release replaces the detection engine with
[artoolkit5-ts](https://github.com/AR-js-org/artoolkit5-ts) 0.2.0. It is a
breaking change.

**`ar:getMarker` is removed.** It exposed artoolkit5-js internals — `idPatt`,
`cfPatt`, `vertex` — that artoolkit5-ts does not produce. Use `ar:markerFound`,
`ar:markerUpdated` and `ar:markerLost`, which carry the same pose information in
a stable shape.

**Event payloads are renamed.** `id` becomes `markerId` and `poseMatrix` becomes
`matrix`, matching AR.js-next's documented contract. A new `type` field carries
the marker family (`"pattern"` or `"barcode"`).

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
consumer can have depended on it. Proper corner data is back as `vertex` on the
marker events, with `dir` to resolve its order — see [Events](#events-).

**`getMarkerState` takes the marker family.**

```js
plugin.getMarkerState(3, "pattern");
```

Pattern and barcode markers have independent ID registries — both start at 0 —
so an ID alone does not identify a marker. The second argument defaults to
`"pattern"`, so existing single-argument calls for pattern markers keep working
unchanged.

**`artoolkitModuleUrl` is renamed `wasmUrl`, and `wasmBaseUrl` is removed.**
`wasmUrl` matches artoolkit5-ts's `createARToolKitState` and points directly at
the `artoolkit5.wasm` binary, not at a JavaScript module or a base directory.
`wasmBaseUrl` never configured anything after the migration — the detector
takes one explicit file URL, not a base directory to resolve against — so it
was deleted rather than left as a silent no-op.

**`wasmUrl` is effectively required.** Vite's library build does not copy
`artoolkit5.wasm` into `dist/`. Without `wasmUrl`, artoolkit5-ts falls back to
the bare filename, which Emscripten then resolves relative to the worker
chunk — where it 404s. That failure is caught and retried with backoff inside
the detector rather than thrown, so **no `ar:workerError` fires** (fixed in
0.3.0, which reports the first failure through `ar:workerError`). The
detector only gives up (and rejects its own readiness) after six consecutive
failures, which takes far longer than ten seconds at its backoff schedule, so
in practice `plugin.loadMarker()` always hits its own 10-second client-side
timeout first. **The visible symptom is `loadMarker()` hanging for about ten
seconds and then rejecting with `"loadMarker request timed out"`, with
nothing else logged.** If you hit exactly that, you are almost certainly
missing `wasmUrl`. See [Using the ESM build](#using-the-esm-build-recommended-)
for how to point it at the binary, and [Troubleshooting](#troubleshooting-)
for the full explanation.

**Detection is browser-only.** It requires `Worker` and `OffscreenCanvas`. The
`worker_threads` path is removed; it never functioned. `worker: false` still
runs the plugin lifecycle under Node.

**`minConfidence` is now a public constructor option.** It was previously
hardcoded at 0.6 inside the worker and reachable only through a raw `init`
message. The default is unchanged, so detection behaviour is the same unless
you opt to change it.

Barcode markers and detector options, listed here as not yet supported in
0.2.0, arrived in 0.3.0.

<a id="installation-"></a>

## Installation 📦

```bash
npm install @ar-js-org/arjs-plugin-artoolkit @ar-js-org/artoolkit5-wasm
```

`@ar-js-org/artoolkit5-wasm` provides the ARToolKit binary the plugin loads
through `wasmUrl`. The plugin already depends on it indirectly, through
`@ar-js-org/artoolkit5-ts`, but list it as a **direct** dependency: under pnpm
and other strict installs a transitive package cannot be imported, and a
bundler import of the binary (below) needs version 0.4.1 or later.

<a id="using-the-esm-build-recommended-"></a>

## Using the ESM build (recommended) 🚀

When you import the built ESM bundle from `dist/`, the plugin's own JavaScript
— including the worker chunk — is already bundled and referenced correctly.
You don't need to configure anything for that part.

The ARToolKit **WASM binary is a separate story.** Vite's library build does
not copy `artoolkit5.wasm` into `dist/`, so you must tell the plugin where to
find it by passing `wasmUrl` — see
[Upgrading to 0.2.0](#upgrading-to-020-) for why. The binary ships inside
`@ar-js-org/artoolkit5-wasm`, a transitive dependency pulled in by
`@ar-js-org/artoolkit5-ts`, so after `npm install` it already exists on disk
at:

```
node_modules/@ar-js-org/artoolkit5-wasm/dist/artoolkit5.wasm
```

Serve that path (or copy the file into wherever you serve static assets and
point `wasmUrl` there instead):

```html
<script type="module">
  import { ArtoolkitPlugin } from '/dist/arjs-plugin-artoolkit.es.js';

  const engine = { eventBus: /* your event bus */ };

  const plugin = new ArtoolkitPlugin({
    worker: true,
    cameraParametersUrl: '/path/to/camera_para.dat',
    wasmUrl: '/node_modules/@ar-js-org/artoolkit5-wasm/dist/artoolkit5.wasm',
    minConfidence: 0.6
  });

  await plugin.init(engine);
  await plugin.enable();
  console.log('Plugin version:', plugin.version);
</script>
```

If `wasmUrl` is missing or unreachable, nothing fails where you'd expect it
to — `loadMarker()` just hangs and times out. See
[Troubleshooting](#troubleshooting-) for the exact symptom.

Serving notes:

- Serve from a web server so `/dist` assets resolve. The build is configured with `base: './'`, so the worker asset is referenced relative to the ESM file (e.g., `/dist/assets/worker-*.js`).
- In your own apps, place `dist/` where you serve static assets and import the ESM with the appropriate path (absolute or relative). Do the same for `artoolkit5.wasm`: it does not have to live under `node_modules` in production, as long as `wasmUrl` points at wherever it ends up.

### With a bundler (Vite) 📦

A bundler can resolve the binary's URL for you. `@ar-js-org/artoolkit5-wasm`
0.4.1 and later export `./dist/artoolkit5.wasm`, so with Vite:

```js
import { ArtoolkitPlugin } from "@ar-js-org/arjs-plugin-artoolkit";
import wasmUrl from "@ar-js-org/artoolkit5-wasm/dist/artoolkit5.wasm?url";

const plugin = new ArtoolkitPlugin({
  wasmUrl,
  cameraParametersUrl: "/data/camera_para.dat",
});
```

Vite copies the binary into the build and hands you its final URL, in dev and
in production alike. Two settings in `vite.config.js` matter:

```js
export default {
  optimizeDeps: {
    // Pre-bundling moves the plugin into node_modules/.vite/deps, where the
    // relative URL of its worker no longer resolves.
    exclude: ["@ar-js-org/arjs-plugin-artoolkit"],
  },
};
```

With `@ar-js-org/artoolkit5-wasm` 0.4.0 the import fails with
`Missing "./dist/artoolkit5.wasm" specifier`: that version ships the binary
but does not export it. Depend on `^0.4.1`.

<a id="using-source-development-mode-"></a>

## Using source (development mode) 🛠️

If you develop against `src/` (not the built `dist/`),
`src/detector/artoolkit-detector.js` imports `@ar-js-org/artoolkit5-ts`
directly as a bare module specifier. A plain static file server does not know
how to resolve that; use a dev server that resolves bare specifiers from
`node_modules` (Vite's own dev server does this natively), or serve an import
map that points `@ar-js-org/artoolkit5-ts` at a reachable copy.

`wasmUrl` is required here too, exactly as with the `dist/` build (see
[Upgrading to 0.2.0](#upgrading-to-020-)) — pass it directly, since nothing
bundles the binary for you:

```js
const plugin = new ArtoolkitPlugin({
  worker: true,
  cameraParametersUrl: "/path/to/camera_para.dat",
  wasmUrl: "/node_modules/@ar-js-org/artoolkit5-wasm/dist/artoolkit5.wasm",
  minConfidence: 0.6,
});
console.log("Plugin version:", plugin.version);
```

Notes:

- The previous loader.js and manual WASM placement flow is no longer used.
- There is no longer a configurable URL for the ARToolKit _library_
  JavaScript — the two options that used to serve that purpose were removed
  in 0.2.0 (see [Upgrading to 0.2.0](#upgrading-to-020-)). `wasmUrl` is the
  only remaining runtime-configurable path, and it points at the WASM binary,
  not at a module.

<a id="usage-"></a>

## Usage 🧩

<a id="quick-start-copy-paste-"></a>

### Quick Start (copy-paste) ⚡

```js
import { ArtoolkitPlugin } from "@ar-js-org/arjs-plugin-artoolkit";

// Minimal event bus stub
const eventBus = {
  _h: new Map(),
  on(e, h) {
    if (!this._h.has(e)) this._h.set(e, []);
    this._h.get(e).push(h);
  },
  emit(e, p) {
    (this._h.get(e) || []).forEach((fn) => {
      try {
        fn(p);
      } catch (err) {
        console.error(err);
      }
    });
  },
};
const engine = { eventBus };

const plugin = new ArtoolkitPlugin({
  worker: true,
  wasmUrl: "/node_modules/@ar-js-org/artoolkit5-wasm/dist/artoolkit5.wasm",
  minConfidence: 0.6,
});
await plugin.init(engine);
await plugin.enable();
console.log("Version:", plugin.version);

// Marker loading waits for the detector, and the detector only initialises
// once it has seen a frame — it needs the real frame dimensions, which are
// fixed permanently at initialisation. Make sure your capture source is
// running and emitting `engine:update` (see Sending frames below) before
// you get here, or this call hangs until it times out.
await plugin.loadMarker("/examples/simple-marker/data/patt.hiro", 1); // size is world units

eventBus.on("ar:markerFound", (m) => console.log("FOUND", m.type, m.markerId));
eventBus.on("ar:markerUpdated", (m) =>
  console.log("UPDATED", m.type, m.markerId),
);
eventBus.on("ar:markerLost", (m) => console.log("LOST", m.type, m.markerId));
```

<a id="register-and-enable-"></a>

### Register and enable ✅

```js
import { ArtoolkitPlugin } from "@ar-js-org/arjs-plugin-artoolkit";

const plugin = new ArtoolkitPlugin({
  worker: true,
  lostThreshold: 5, // consecutive missed frames before a marker is considered lost
  frameDurationMs: 100, // expected ms per frame (sizes the stall guard)
  wasmUrl: "/node_modules/@ar-js-org/artoolkit5-wasm/dist/artoolkit5.wasm",
  cameraParametersUrl: "/data/camera_para.dat",
  minConfidence: 0.6,
});

engine.pluginManager.register("artoolkit", plugin);
await engine.pluginManager.enable("artoolkit");
```

<a id="events-"></a>

### Events 🔔

The plugin emits the following events on your engine’s event bus:

| Event              | Payload                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `ar:markerFound`   | `{ markerId, type, matrix, confidence, vertex, dir, timestamp }` |
| `ar:markerUpdated` | `{ markerId, type, matrix, confidence, vertex, dir, timestamp }` |
| `ar:markerLost`    | `{ markerId, type, timestamp }`                                  |
| `ar:workerReady`   | `{}`                                                             |
| `ar:workerError`   | `{ message }`                                                    |
| `ar:camera`        | `{ projectionMatrix, width, height, timestamp }`                 |

`matrix` is a `Float32Array(16)`, 4x4 column-major right-handed — ready for
WebGL and for `THREE.Matrix4.fromArray()` with no conversion. `type` is
`"pattern"` or `"barcode"`. A marker's real identity is the pair
`type:markerId`, not `markerId` alone — pattern and barcode markers keep
independent ID registries, so a barcode marker and a pattern marker can both
report `markerId: 0` while being two different markers.

`ar:camera` gives the camera projection to render those poses with, also a
`Float32Array(16)`, computed by ARToolKit from your `camera_para.dat`. It fires
when the first frame reaches the detector, and again whenever `nearPlane` or
`farPlane` is configured, since those recompute it. Set it as your 3D camera's
projection matrix; `arjs-plugin-threejs` does this on `ar:camera`. If your
renderer starts later, call `artoolkit.getProjectionMatrix()`, which returns
the current values, or `null` before the first frame.

`vertex` is the detected square's four corners as `[[x, y], …]`, in the pixel
coordinates of the **frame you submitted** — not of however the video is
displayed. Those differ whenever the video is rendered at anything other than its
native size, which is the usual case; `examples/simple-marker/` shows the
scaling. Corners alone are enough to outline a marker, hit-test it or mask it,
with no pose matrix involved. Unlike `matrix` it is freshly allocated per frame,
so you may retain it.

Both fields are **well-formed or absent, never malformed**: the plugin validates
them before emitting and never invents a value, so a detection that arrives
without them emits `undefined` rather than something plausible. The keys are
always on the payload. With the pinned artoolkit5-ts range every real detection
carries both, so in normal use you can read them directly.

`dir` is the marker's rotation, 0 to 3, and is what makes `vertex` order mean
something. Corner order follows ARToolKit's square tracer, not the printed
marker, so `vertex[0]` is a different physical corner depending on how the marker
is turned. To name a corner:

```js
const topLeft = vertex[(4 - dir) % 4];
```

with the rest clockwise from there as `(5 - dir) % 4`, `(6 - dir) % 4` and
`(7 - dir) % 4`. That is ARToolKit's own mapping — the one it feeds its pose
solver — not a convention invented here. Outlining and hit-testing need none of
it, since any order traces the same quadrilateral; it matters when a specific
printed corner has to be identified, such as anchoring a label or mapping a
texture.

```js
// Marker first detected
engine.eventBus.on(
  "ar:markerFound",
  ({ markerId, type, matrix, confidence, vertex, dir, timestamp }) => {
    // matrix is Float32Array(16)
    // vertex is [[x, y], [x, y], [x, y], [x, y]] in submitted-frame pixels
    // the marker's own top-left corner is vertex[(4 - dir) % 4]
  },
);

// Marker updated (tracking)
engine.eventBus.on("ar:markerUpdated", (data) => {
  // same shape as markerFound
});

// Marker lost
engine.eventBus.on("ar:markerLost", ({ markerId, type, timestamp }) => {});

// Worker lifecycle
engine.eventBus.on("ar:workerReady", () => {});
engine.eventBus.on("ar:workerError", (error) => {});
```

<a id="sending-frames-"></a>

### Sending frames 🎞️

```js
// Create ImageBitmap from a <video> or <canvas>
const imageBitmap = await createImageBitmap(video);

// Emit an engine update; the plugin transfers the ImageBitmap to the worker
engine.eventBus.emit("engine:update", {
  id: frameId,
  timestamp: Date.now(),
  imageBitmap,
  width: imageBitmap.width,
  height: imageBitmap.height,
});

// The ImageBitmap is transferred and cannot be reused; the worker will close it.
```

At most one frame is ever in flight to the worker at a time. If an
`engine:update` arrives while the previous frame is still being detected, the
plugin drops it — closing its `ImageBitmap` rather than transferring it — and
waits for the worker to finish the one it already has. This is deliberate
backpressure, not a bug: it keeps a slow detector from building an unbounded
backlog (which would otherwise starve `loadMarker()` behind queued frames).
Emit frames as often as you like; the plugin decides how many it can use. An
`engine:update` without an `imageBitmap`, such as the engine's own
`{ deltaTime, context }` tick, is ignored.

<a id="loading-a-pattern-marker-"></a>

### Loading a pattern marker 📐

```js
const { markerId, size } = await plugin.loadMarker(
  "/examples/simple-marker/data/patt.hiro",
  1,
);
```

<a id="tracking-a-barcode-marker-"></a>

### Tracking a barcode marker 🔢

Barcode (matrix code) markers encode their ID in the marker itself, so there
is no file to load: register the ID you want to follow.

```js
const plugin = new ArtoolkitPlugin({
  wasmUrl,
  cameraParametersUrl,
  detectionMode: "color_and_matrix", // pattern + barcode in the same frame
  matrixCodeType: "3x3", // the engine default
});
// ... register, enable, start sending frames ...

await plugin.trackBarcode(5, 1); // barcode ID 5, width 1

engine.eventBus.on("ar:markerFound", ({ markerId, type }) => {
  if (type === "barcode" && markerId === 5) {
    /* … */
  }
});
```

- **Detection mode.** ARToolKit reports barcodes only in `matrix`,
  `color_and_matrix` or `mono_and_matrix` mode. If the current mode cannot see
  barcodes, `trackBarcode` switches it to `color_and_matrix` (or
  `mono_and_matrix` from `mono`) and logs a warning. Use `matrix` alone if you
  track no pattern markers.
- **IDs depend on `matrixCodeType`.** `3x3` encodes IDs 0–63; `4x4` 0–8191;
  the BCH and parity variants trade range for error correction. Generate
  markers for the same dictionary you configure.
- **Pattern and barcode IDs are independent.** Barcode 0 and the first loaded
  pattern (also ID 0) are different markers. Key your own state on
  `type:markerId`.
- **Order.** Like `loadMarker`, `trackBarcode` needs the worker running. It
  may be called before frames flow: the barcode is registered when the
  detector initialises on the first frame, and the promise settles then, so
  it tells you whether the registration was accepted. Like every request it
  times out after 10 s; if no frame arrives by then the call rejects, though
  the barcode is still registered once one does.

<a id="configuring-the-detector-"></a>

### Configuring the detector 🎛️

artoolkit5-ts detector options can be set at construction (`detectionMode`,
`matrixCodeType`, `minConfidence`, and anything else under `detector`) and
changed at runtime. Only the keys you pass change, and `minConfidence` only
for the families you pass: `{ barcode: 0.8 }` leaves the pattern floor as it
was.

```js
const plugin = new ArtoolkitPlugin({
  wasmUrl,
  minConfidence: { pattern: 0.6, barcode: 0.5 },
  detector: { thresholdMode: "auto_otsu" },
});

// later, e.g. from a debug UI
await plugin.configureDetector({ threshold: 120, thresholdMode: "manual" });
```

| Option                  | Values                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `detectionMode`         | `color` (default), `mono`, `matrix`, `color_and_matrix`, `mono_and_matrix`                                                                     |
| `matrixCodeType`        | `3x3` (default), `3x3_PARITY65`, `3x3_HAMMING63`, `4x4`, `4x4_BCH_13_9_3`, `4x4_BCH_13_5_5`, `5x5`, `5x5_BCH_22_7_7`, `5x5_BCH_22_12_5`, `6x6` |
| `thresholdMode`         | `manual`, `auto_median`, `auto_otsu`, `auto_bracketing`                                                                                        |
| `threshold`             | 0–255, used when `thresholdMode` is `manual`                                                                                                   |
| `labelingMode`          | `black_region` (default), `white_region`                                                                                                       |
| `imageProcMode`         | `frame`, `field`                                                                                                                               |
| `patternRatio`          | between 0 and 1, exclusive                                                                                                                     |
| `nearPlane`, `farPlane` | projection clipping planes                                                                                                                     |
| `minConfidence`         | number for both families, or `{ pattern, barcode }`                                                                                            |

An invalid value rejects `configureDetector`; the other options in the same
call still take effect. Called before the first frame, `configureDetector`
settles once the detector initialises, so the rejection still reaches the
caller. An invalid value set at construction is left out and reported through
`ar:workerError` once the detector initialises; everything else, queued
barcodes included, is applied as usual.

<a id="examples-"></a>

## Examples 🧪

A complete webcam-based example is available under `examples/simple-marker/`.

Serve from the repository root so that `dist/` and example paths resolve:

```bash
# From repository root
npx http-server -p 8080
# or
python3 -m http.server 8080
```

Open:

- http://localhost:8080/examples/simple-marker/index.html

The example demonstrates:

- Webcam capture with getUserMedia
- ImageBitmap creation and frame submission
- Loading and tracking two pattern markers from a single plugin instance
- Event handling and console output for `ar:markerFound` / `ar:markerUpdated` / `ar:markerLost`

<a id="api-reference-"></a>

## API Reference 📚

<a id="arplugin-options-"></a>

### ArtoolkitPlugin options 🧭

```text
{
  worker?: boolean;            // Enable worker (default: true)
  lostThreshold?: number;      // Consecutive processed frames without a marker before 'lost' (default: 5)
  frameDurationMs?: number;    // Expected ms per frame; stall guard fires after lostThreshold × this with no frame processed (default: 200)
  sweepIntervalMs?: number;    // Stall-guard check interval (default: 100)
  cameraParametersUrl?: string;// Camera params file URL (required unless you rely on a remote default)
  wasmUrl: string;             // URL of the artoolkit5.wasm binary — effectively required, see Troubleshooting
  minConfidence?: number | { pattern?: number, barcode?: number }; // 0-1 (default: 0.6 for both)
  detectionMode?: string;      // See Configuring the detector (default: engine 'color')
  matrixCodeType?: string;     // Barcode dictionary (default: engine '3x3')
  detector?: object;           // Other artoolkit5-ts DetectorOptions, passed through
}
```

<a id="methods-"></a>

### Methods 🛠️

- `async init(core)` — initialize with engine core
- `async enable()` — start worker and subscribe to frames
- `async disable()` — stop worker and timers
- `dispose()` — alias for disable
- `getMarkerState(markerId, type = 'pattern')` — current tracked state for that marker
- `async loadMarker(patternUrl: string, size = 1)` — load and track a pattern; resolves `{ markerId, size }`
- `async trackBarcode(barcodeId: number, size = 1)` — track a barcode; resolves `{ markerId, size, detectionMode }`
- `async configureDetector(opts)` — change detector options at runtime; resolves `{ config }`

<a id="troubleshooting-"></a>

## Troubleshooting 🧰

- **`loadMarker()` hangs for about ten seconds, then rejects with
  `"loadMarker request timed out"`:**

  This symptom has two distinct causes. If fixing one doesn't help, check the
  other.
  - **Cause 1: missing or unreachable `wasmUrl`.** Since 0.3.0 this also
    fires `ar:workerError` with `ARToolKit initialisation failed …` as soon as
    the first frame arrives.
    - Without `wasmUrl`, artoolkit5-ts resolves the WASM binary as a bare
      filename relative to the worker chunk. Vite's library build does not
      copy `artoolkit5.wasm` into `dist/`, so that lookup 404s.
    - Initialisation keeps retrying with backoff, so `loadMarker()` still
      waits until its own 10-second timeout.
    - Fix: pass `wasmUrl` pointing at the binary —
      `node_modules/@ar-js-org/artoolkit5-wasm/dist/artoolkit5.wasm` after
      `npm install`, served however you serve the rest of your static
      assets, or imported with `?url` under a bundler. See
      [Using the ESM build](#using-the-esm-build-recommended-).
  - **Cause 2: `loadMarker()` was called before any frame was processed.**
    - Detector initialisation is frame-triggered, not `enable()`-triggered:
      it needs real frame dimensions, which are fixed permanently once set,
      so the worker only creates the ARToolKit state when it handles its
      first `processFrame` message. `loadMarker()` never triggers that
      itself — it just waits for the detector to become ready, however that
      happens.
    - Fix: make sure your capture source is running and sending
      `engine:update` frames — see [Sending frames](#sending-frames-) — and
      that at least one has reached the worker before calling
      `loadMarker()`.

- Worker asset 404:
  - Ensure you import the ESM from `/dist/arjs-plugin-artoolkit.es.js` and that `/dist/assets/worker-*.js` is served.
  - The build uses `base: './'`, so worker URLs are relative to the ESM file location.
- “Failed to resolve module specifier” for `@ar-js-org/artoolkit5-ts` (source/dev only):
  - `src/detector/artoolkit-detector.js` imports `@ar-js-org/artoolkit5-ts` as
    a bare specifier. Use a dev server that resolves bare specifiers from
    `node_modules` (Vite's dev server does this natively), or serve an import
    map.
- Worker not starting:
  - Serve via HTTP/HTTPS; ensure ES modules and Workers are supported
- No detections:
  - Confirm camera started, correct marker pattern, sufficient lighting
  - Adjust `minConfidence` to reduce/raise filtering
- Barcode never detected:
  - Check that `matrixCodeType` matches the dictionary the marker was generated for, and that the ID is in its range (0–63 for `3x3`)
  - Barcodes need a matrix-capable `detectionMode`; `trackBarcode` switches to one automatically, but a later `configureDetector({ detectionMode: 'color' })` turns barcode detection off again
  - Check `plugin.version` (if 'unknown', ensure build-time define is configured)

## Build & Publishing Notes

- Sourcemap files (`.map`) generated in `dist/` and `types/` are excluded from the repository and the npm package to reduce package size and avoid shipping debug artifacts.
  - See `.gitignore` and `.npmignore` for details.
- When installing the package from npm (`npm install @ar-js-org/arjs-plugin-artoolkit`), all required built files are included and ready to use.
  - If you install from source (e.g., cloning the repository), you must run the build manually: `npm run build`.
  - This does not include the ARToolKit WASM binary: `dist/` never contains
    `artoolkit5.wasm`. It ships inside the `@ar-js-org/artoolkit5-wasm`
    dependency instead, and you must point `wasmUrl` at it yourself — see
    [Using the ESM build](#using-the-esm-build-recommended-).

### Releases and Built Artifacts

- Built files (`dist/`) and TypeScript declarations (`types/`) are NOT committed to the repository. They are generated by the CI/build process and attached to GitHub Releases as downloadable assets.
- To download the built files for a given release tag (example `v1.2.3`), use the Releases download URL:

  `https://github.com/AR-js-org/arjs-plugin-artoolkit/releases/download/v1.2.3/dist/arjs-plugin-artoolkit.es.js`

- If/when the package is published to npm, you can use jsDelivr to serve files from the npm package:

  `https://cdn.jsdelivr.net/npm/@ar-js-org/arjs-plugin-artoolkit@1.2.3/dist/arjs-plugin-artoolkit.es.js`

- Note: jsDelivr serves files from npm or from the repository tree at a tag/branch. Because `dist/` and `types/` are not committed to the repo, the npm package must contain the built files for jsDelivr to serve them.
