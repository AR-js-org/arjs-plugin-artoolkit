# @ar-js-org/arjs-plugin-artoolkit

ARToolKit marker detection plugin for AR.js core with WebAssembly support.

## Features

- Web Worker-based detection — marker detection runs off the main thread
- ImageBitmap support — zero-copy frame transfer (browser)
- Cross-platform — browser Workers and Node.js worker_threads (stub path)
- ARToolKit integration — square pattern markers
- Event-driven API — marker found/updated/lost + raw getMarker forwarding
- Filtering — only forwards PATTERN_MARKER events above a minimum confidence

## Installation

```bash
npm install @ar-js-org/arjs-plugin-artoolkit
```

## Configuration (module + assets)

To ensure the Worker can import ARToolKit in the browser, pass an explicit ESM URL (recommended):

```js
const plugin = new ArtoolkitPlugin({
  worker: true,
  artoolkitModuleUrl: '/node_modules/@ar-js-org/artoolkit5-js/dist/ARToolkit.js', // explicit ESM
  cameraParametersUrl: '/path/to/camera_para.dat',                                // optional override
  wasmBaseUrl: '/node_modules/@ar-js-org/artoolkit5-js/dist/',                    // optional; if your build needs it
  minConfidence: 0.6                                                              // forward only confident detections
});
```

CDN fallback (if you don’t serve node_modules):
- Set `artoolkitModuleUrl` to a CDN ESM endpoint, e.g. a jsDelivr/UNPKG URL for the package’s ESM bundle.

Notes:
- The previous “loader.js” and manual WASM placement flow is no longer used.
- If your ARToolKit build fetches auxiliary assets (WASM, data), set `wasmBaseUrl` accordingly.

## Usage

### Register and enable

```js
import { ArtoolkitPlugin } from '@ar-js-org/arjs-plugin-artoolkit';

const plugin = new ArtoolkitPlugin({
  worker: true,
  lostThreshold: 5,       // frames before a marker is considered lost
  frameDurationMs: 100,   // expected ms per frame (affects lost timing)
  artoolkitModuleUrl: '/node_modules/@ar-js-org/artoolkit5-js/dist/ARToolkit.js',
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

Serve from the repository root so that ES modules and node_modules paths resolve:

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
  frameDurationMs?: number;    // ms per frame (default: 200)
  sweepIntervalMs?: number;    // Lost-sweep interval (default: 100)
  artoolkitModuleUrl?: string; // ESM URL for ARToolKit (recommended)
  cameraParametersUrl?: string;// Camera params file URL
  wasmBaseUrl?: string;        // Base URL for ARToolKit assets (if required)
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

- “Failed to resolve module specifier” in the Worker:
    - Provide `artoolkitModuleUrl` or serve `/node_modules` from your dev server
- Worker not starting:
    - Serve via HTTP/HTTPS; ensure ES modules and Workers are supported
- No detections:
    - Confirm camera started, correct marker pattern, sufficient lighting
    - Adjust `minConfidence` to reduce/raise filtering