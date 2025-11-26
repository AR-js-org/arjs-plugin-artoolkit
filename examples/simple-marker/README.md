# Simple Marker Example

This example demonstrates how to load and track a pattern marker using the ARToolKit plugin.

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

If you prefer rapid iteration against source with hot-reload (and are comfortable configuring module URLs manually), you can instead run:

```bash
npm run dev
```

### 4. Using the Example

1. Wait for the worker to be ready (`ar:workerReady` event – UI shows “Worker ready”).
2. Click “Start Camera” to begin sending frames.
3. Click “Load Marker” to load the Hiro pattern marker.
4. Show the marker to the camera and watch the event log and console.
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

If you develop against `src/` instead (without bundling yet), provide an explicit ARToolKit module URL. You can also override camera parameters (local file included), WASM base URL, and detection confidence:

> **Note:** The previous `dev/smoke-browser.html` example is deprecated and references to it have been removed due to browser module loading issues. For development against `src/`, ensure you provide correct module URLs and configuration, but do not rely on the old smoke test example.

## What’s Happening

This example demonstrates:

1. Plugin Initialization: creating and enabling `ArtoolkitPlugin`.
2. Worker Communication: the plugin starts a Worker for detection.
3. Pattern Loading: `plugin.loadMarker('/examples/simple-marker/data/patt.hiro', 1)`.
4. Version Access: `plugin.version` (instance) or `ARTOOLKIT_PLUGIN_VERSION` (constant) for diagnostics.
5. Event Handling:
   - `ar:workerReady` — Worker initialized
   - `ar:markerFound` — First detection of a marker
   - `ar:markerUpdated` — Subsequent tracking updates
   - `ar:markerLost` — Marker no longer visible
   - `ar:getMarker` — Raw ARToolKit getMarker payload (type, matrix, marker fields)

## Pattern File

The `data/patt.hiro` file is a standard ARToolKit pattern. You can replace it with your own pattern and update the URL accordingly.

The `camera_para.dat` file is included locally under `examples/simple-marker/data/` and is referenced directly in the examples above.

## Code Overview

Key parts of the example:

```javascript
// Create plugin instance with worker enabled (no artoolkitModuleUrl needed with dist build)
const plugin = new ArtoolkitPlugin({
  worker: true,
  cameraParametersUrl: "/examples/simple-marker/data/camera_para.dat",
});

// Initialize and enable
await plugin.init(core);
await plugin.enable();

// Load a pattern marker
const result = await plugin.loadMarker(
  "/examples/simple-marker/data/patt.hiro",
  1,
);
console.log(`Marker loaded with ID: ${result.markerId}`);
```

## Troubleshooting

**Worker not loading or module loading errors?**

- Ensure you’re serving via HTTP/HTTPS from the repository root (not `file://`).
- Confirm `/dist/arjs-plugin-artoolkit.es.js` and `/dist/assets/worker-*.js` are reachable (note: filename is `.es.js`, not `.esm.js`).
- If you see errors like `Failed to resolve module specifier` or `ARController export not found`, check that you are using the correct build and serving files from the right location. See the Known Issues/FAQ section above for more details.
- Marker not loading?
  - Verify the pattern file path is correct and accessible
  - Ensure the worker is ready before calling `loadMarker()`
- No detections?
  - Click “Start Camera” before “Load Marker”
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
