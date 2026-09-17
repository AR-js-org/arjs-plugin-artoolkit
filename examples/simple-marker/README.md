# Simple Marker Example

This example demonstrates how to load and track two pattern markers (hiro and kanji) from a single `ArtoolkitPlugin` instance using the ARToolKit plugin.

## Setup Instructions

### 1. Install Dependencies

From the repository root, install the dependencies:

```bash
npm install
```

### 2. Serve the Example

You must serve from the repository root so that:

- The built ESM bundle (`/dist/arjs-plugin-artoolkit.es.js`) and worker asset (`/dist/assets/worker-*.js`) resolve
- Example paths under `/examples/simple-marker/` resolve
- Relative module URLs (e.g. pattern files) resolve correctly

You can use any static file server. Examples:

#### Option A: Using Python

```bash
# From repository root
python3 -m http.server 8080
```

Then open: http://localhost:8080/examples/simple-marker/index.html

#### Option B: Using Node.js http-server

```bash
# Install http-server globally if not already installed
npm install -g http-server

# From repository root
http-server -p 8080
```

Then open: http://localhost:8080/examples/simple-marker/index.html

#### Option C: Using VS Code Live Server

If you're using VS Code with the Live Server extension:

1. Right-click on `examples/simple-marker/index.html`
2. Select "Open with Live Server"

### 3. Build (if using dist/)

If you want to use the pre-bundled ESM from `dist/`, build it first:

```bash
npm run build
```

This package does not ship a dedicated dev-server script — `npm run build`
above is the supported way to produce a servable bundle for this example.

### 4. Using the Example

1. Wait for the worker to be ready (`ar:workerReady` event – UI shows “Worker ready”).
2. Click “Start Camera” to begin sending frames.
3. Click “Load Markers” to load both the hiro and kanji pattern markers.
4. Show either marker to the camera and watch the event log and console — each
   one reports its own `markerId`.
5. (Optional) Log the plugin version: `console.log(plugin.version)`.

## Module resolution

When importing the built ESM from `dist/`, ARToolKit is bundled and no extra configuration is required. The plugin also exposes the build-time version constant. Since `camera_para.dat` is now included locally in this example, we reference it directly:

```js
import {
  ArtoolkitPlugin,
  ARTOOLKIT_PLUGIN_VERSION,
} from "/dist/arjs-plugin-artoolkit.es.js";

const plugin = new ArtoolkitPlugin({
  worker: true,
  cameraParametersUrl: "/examples/simple-marker/data/camera_para.dat",
});

console.log("Plugin version (constant):", ARTOOLKIT_PLUGIN_VERSION);
console.log("Plugin version (instance):", plugin.version);
```

If you develop against `src/` instead (without bundling yet), import `ArtoolkitPlugin` directly from `src/index.js`. You can override camera parameters (local file included), the ARToolKit WASM binary URL (`wasmUrl`), and the detection confidence floor (`minConfidence`):

> **Note:** The previous `dev/smoke-browser.html` example is deprecated and references to it have been removed due to browser module loading issues. For development against `src/`, ensure you provide correct module URLs and configuration, but do not rely on the old smoke test example.

## What’s Happening

This example demonstrates:

1. Plugin Initialization: creating and enabling `ArtoolkitPlugin`.
2. Worker Communication: the plugin starts a Worker for detection.
3. Pattern Loading: two `plugin.loadMarker(url, 1)` calls, one for
   `patt.hiro` and one for `patt.kanji`, each resolving with its own
   `markerId`.
4. Version Access: `plugin.version` (instance) or `ARTOOLKIT_PLUGIN_VERSION` (constant) for diagnostics.
5. Event Handling:
   - `ar:workerReady` — Worker initialized
   - `ar:markerFound` — First detection of a marker
   - `ar:markerUpdated` — Subsequent tracking updates
   - `ar:markerLost` — Marker no longer visible

## Pattern Files

The `data/patt.hiro` and `data/patt.kanji` files are standard ARToolKit patterns. You can replace either with your own pattern and update the corresponding URL in `index.html` accordingly.

The `camera_para.dat` file is included locally under `examples/simple-marker/data/` and is referenced directly in the examples above.

## Tracking Multiple Patterns

This example loads two pattern markers from a single `ArtoolkitPlugin`
instance to show that multi-marker tracking already works end to end:

- Each `plugin.loadMarker(url, size)` call resolves independently with its
  own `{ markerId, size }`. Loading is deduplicated by URL, so loading the
  same pattern twice returns the same `markerId` instead of registering a
  duplicate.
- Every `ar:markerFound`, `ar:markerUpdated` and `ar:markerLost` event
  carries both `markerId` and `type`. A marker's real identity is the pair
  `type:markerId`, not `markerId` alone — pattern and barcode markers keep
  independent ID registries, so a barcode marker and a pattern marker can
  both report `markerId: 0` while being two different markers. That is why
  the event log always prints both fields together, e.g.
  `FOUND pattern:1 cf=0.82`.
- Present either printed pattern to the camera: the log shows a `FOUND` line
  for that marker's own `type:markerId`, and a `LOST` line for that same
  `type:markerId` — and only that one — when you remove it. The other
  marker keeps tracking independently.

## Code Overview

Key parts of the example:

```javascript
// Create plugin instance with worker enabled
const plugin = new ArtoolkitPlugin({
  worker: true,
  cameraParametersUrl: "/examples/simple-marker/data/camera_para.dat",
});

// Initialize and enable
await plugin.init(core);
await plugin.enable();

// Load both pattern markers — each resolves with its own ID
const hiro = await plugin.loadMarker(
  "/examples/simple-marker/data/patt.hiro",
  1,
);
const kanji = await plugin.loadMarker(
  "/examples/simple-marker/data/patt.kanji",
  1,
);
console.log(`hiro loaded with ID: ${hiro.markerId}`);
console.log(`kanji loaded with ID: ${kanji.markerId}`);
```

## Troubleshooting

**Worker not loading or module loading errors?**

- Ensure you’re serving via HTTP/HTTPS from the repository root (not `file://`).
- Confirm `/dist/arjs-plugin-artoolkit.es.js` and `/dist/assets/worker-*.js` are reachable (note: filename is `.es.js`, not `.esm.js`).
- If you see errors like `Failed to resolve module specifier`, check that you are using the correct build and serving files from the right location. See the Known Issues/FAQ section above for more details.
- Marker not loading?
  - Verify the pattern file path is correct and accessible
  - Ensure the worker is ready before calling `loadMarker()`
- No detections?
  - Click “Start Camera” before “Load Markers”
  - Ensure good lighting and the correct marker
  - Adjust `minConfidence` in the plugin options (default 0.6) if detections are too strict or too noisy.

## Browser Support

This example requires:

- ES modules
- Web Workers
- Modern browser (Chrome 80+, Firefox 75+, Safari 13.1+, Edge 80+)

## Known Issues / FAQ

- **Why was `dev/smoke-browser.html` removed?**
  - The smoke test relied on browser module loading that is not reliable across environments and caused confusion for users. Please use the `examples/simple-marker` for browser testing.
- **Why do I get module loading errors?**
  - Always use the ESM build from `dist/` and serve from the repository root. If you develop against `src/`, ensure you provide correct module URLs and configuration.
- **How do I test changes?**
  - Use the `examples/simple-marker` example and follow the setup instructions above.
