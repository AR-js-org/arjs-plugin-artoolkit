# arjs-plugin-artoolkit

ARToolKit marker detection plugin for AR.js core with WebAssembly support.

## Features

- Web Worker-based detection — marker detection runs off the main thread (Browser Module Worker)
- ImageBitmap support — zero-copy frame transfer (browser)
- ARToolKit integration — square pattern markers
- Event-driven API — marker found/updated/lost + raw getMarker forwarding
- Filtering — only forwards PATTERN_MARKER events above a minimum confidence

## Version

The plugin exposes its build-time version both as a constant and on each instance:

```js
import { ArtoolkitPlugin, ARTOOLKIT_PLUGIN_VERSION } from '@ar-js-org/arjs-plugin-artoolkit';

console.log('Build version:', ARTOOLKIT_PLUGIN_VERSION); // e.g. 0.1.0 or 'unknown'
const plugin = new ArtoolkitPlugin();
console.log('Instance version:', plugin.version);
```

If the build define is missing (e.g. raw source / some test runners), the version falls back to `'unknown'`.

## Installation

```bash
// Attention!! not yet published!
npm install @ar-js-org/arjs-plugin-artoolkit
```

## Using the ESM build (recommended)

When you import the built ESM bundle from `dist/`, the worker and ARToolKit are already bundled and referenced correctly. You do NOT need to pass `artoolkitModuleUrl`.

Example:

```html
<script type="module">
  import { ArtoolkitPlugin } from '/dist/arjs-plugin-artoolkit.es.js';

  const engine = { eventBus: /* your event bus */ };

  const plugin = new ArtoolkitPlugin({
    worker: true,
    cameraParametersUrl: '/path/to/camera_para.dat',
    minConfidence: 0.6
  });

  await plugin.init(engine);
  await plugin.enable();
  console.log('Plugin version:', plugin.version);
</script>
```

Serving notes:
- Serve from a web server so `/dist` assets resolve. The build is configured with `base: './'`, so the worker asset is referenced relative to the ESM file (e.g., `/dist/assets/worker-*.js`).
- In your own apps, place `dist/` where you serve static assets and import the ESM with the appropriate path (absolute or relative).

## Using source (development mode)

If you develop against `src/` (not the built `dist/`), the worker will attempt to dynamically import ARToolKit. In that case you should provide `artoolkitModuleUrl` or ensure your dev server can resolve `@ar-js-org/artoolkit5-js`.

```js
const plugin = new ArtoolkitPlugin({
  worker: true,
  artoolkitModuleUrl: '/node_modules/@ar-js-org/artoolkit5-js/dist/ARToolkit.js', // provide when using src/
  cameraParametersUrl: '/path/to/camera_para.dat',
  wasmBaseUrl: '/node_modules/@ar-js-org/artoolkit5-js/dist/', // optional; if your build requires it
  minConfidence: 0.6
});
console.log('Plugin version:', plugin.version);
```

CDN fallback (for source/dev):
- Set `artoolkitModuleUrl` to a CDN ESM endpoint (e.g., jsDelivr/UNPKG) for `@ar-js-org/artoolkit5-js`.

Notes:
- The previous “loader.js” and manual WASM placement flow is no longer used.
- In the `dist/` build, ARToolKit is bundled and `artoolkitModuleUrl` is NOT needed.

## Usage

### Quick Start (copy-paste)

```js
import { ArtoolkitPlugin } from '@ar-js-org/arjs-plugin-artoolkit';

// Minimal event bus stub
const eventBus = {
  _h: new Map(),
  on(e,h){ if(!this._h.has(e)) this._h.set(e,[]); this._h.get(e).push(h); },
  emit(e,p){ (this._h.get(e)||[]).forEach(fn=>{ try{ fn(p); } catch(err){ console.error(err); } }); }
};
const engine = { eventBus };

const plugin = new ArtoolkitPlugin({ worker: true, minConfidence: 0.6 });
await plugin.init(engine);
await plugin.enable();
console.log('Version:', plugin.version);

// Load a marker (size is world units)
await plugin.loadMarker('/examples/simple-marker/data/patt.hiro', 1);

eventBus.on('ar:markerFound', m => console.log('FOUND', m.id));
eventBus.on('ar:markerUpdated', m => console.log('UPDATED', m.id));
eventBus.on('ar:markerLost', m => console.log('LOST', m.id));
```

### Register and enable

```js
import { ArtoolkitPlugin } from '@ar-js-org/arjs-plugin-artoolkit';

const plugin = new ArtoolkitPlugin({
  worker: true,
  lostThreshold: 5,       // frames before a marker is considered lost
  frameDurationMs: 100,   // expected ms per frame (affects lost timing)
  // artoolkitModuleUrl: '/node_modules/@ar-js-org/artoolkit5-js/dist/ARToolkit.js', // Only for src/dev
  cameraParametersUrl: '/data/camera_para.dat',
  minConfidence: 0.6
});

engine.pluginManager.register('artoolkit', plugin);
await engine.pluginManager.enable('artoolkit');
```

### Events

The plugin emits the following events on your engine’s event bus:

```js
// Marker first detected
engine.eventBus.on('ar:markerFound', ({ id, poseMatrix, confidence, corners }) => {
  // poseMatrix is Float32Array(16)
});

// Marker updated (tracking)
engine.eventBus.on('ar:markerUpdated', (data) => {
  // same shape as markerFound
});

// Marker lost
engine.eventBus.on('ar:markerLost', ({ id }) => {});

// Worker lifecycle
engine.eventBus.on('ar:workerReady', () => {});
engine.eventBus.on('ar:workerError', (error) => {});

// Raw ARToolKit getMarker (filtered: PATTERN_MARKER only, above minConfidence)
engine.eventBus.on('ar:getMarker', (payload) => {
  // payload = { type, matrix: number[16], marker: { idPatt, cfPatt, idMatrix?, cfMatrix?, vertex? } }
});
```

### Sending frames

```js
// Create ImageBitmap from a <video> or <canvas>
const imageBitmap = await createImageBitmap(video);

// Emit an engine update; the plugin transfers the ImageBitmap to the worker
engine.eventBus.emit('engine:update', {
  id: frameId,
  timestamp: Date.now(),
  imageBitmap,
  width: imageBitmap.width,
  height: imageBitmap.height
});

// The ImageBitmap is transferred and cannot be reused; the worker will close it.
```

### Loading a pattern marker

```js
const { markerId, size } = await plugin.loadMarker('/examples/simple-marker/data/patt.hiro', 1);
```

## Examples

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
- Event handling and console output
- Raw `ar:getMarker` payloads for debugging

## API Reference

### ArtoolkitPlugin options

```ts
{
  worker?: boolean;            // Enable worker (default: true)
  lostThreshold?: number;      // Frames before 'lost' (default: 5)
  frameDurationMs?: number;    // ms per frame used with lostThreshold (default: 200)
  sweepIntervalMs?: number;    // Lost-sweep interval (default: 100)
  artoolkitModuleUrl?: string; // Only needed when using source/dev; not needed for dist build
  cameraParametersUrl?: string;// Camera params file URL (required unless you rely on a remote default)
  wasmBaseUrl?: string;        // Base URL for ARToolKit assets (optional)
  minConfidence?: number;      // Minimum confidence to forward getMarker (default: 0.6)
}
```

### Methods

- `async init(core)` — initialize with engine core
- `async enable()` — start worker and subscribe to frames
- `async disable()` — stop worker and timers
- `dispose()` — alias for disable
- `getMarkerState(markerId)` — current tracked state
- `async loadMarker(patternUrl: string, size = 1)` — load and track a pattern

## Troubleshooting

- Worker asset 404:
    - Ensure you import the ESM from `/dist/arjs-plugin-artoolkit.es.js` and that `/dist/assets/worker-*.js` is served.
    - The build uses `base: './'`, so worker URLs are relative to the ESM file location.
- “Failed to resolve module specifier” in the Worker (source/dev only):
    - Provide `artoolkitModuleUrl` or serve `/node_modules` from your dev server
- Worker not starting:
    - Serve via HTTP/HTTPS; ensure ES modules and Workers are supported
- No detections:
    - Confirm camera started, correct marker pattern, sufficient lighting
    - Adjust `minConfidence` to reduce/raise filtering
  - Check `plugin.version` (if 'unknown', ensure build-time define is configured)