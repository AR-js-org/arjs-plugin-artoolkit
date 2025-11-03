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
- ES modules resolve (../../src/plugin.js)
- The worker module URL (../../node_modules/...) is reachable

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

### 3. Using the Example

1. Wait for the worker to be ready (status will change to “Worker ready”)
2. Click “Start Camera” to begin sending frames
3. Click “Load Marker” to load the Hiro pattern marker
4. Show the marker to the camera and watch the event log and console

## Module resolution

The example config (in `index.html`) passes explicit URLs so the worker can import ARToolKit and camera params:

```js
const plugin = new ArtoolkitPlugin({
  worker: true,
  artoolkitModuleUrl: '/node_modules/@ar-js-org/artoolkit5-js/dist/ARToolkit.js',
  cameraParametersUrl: '/examples/simple-marker/data/camera_para.dat'
});
```

If your server can’t serve `/node_modules`, either:
- Adjust `artoolkitModuleUrl` to a path your server exposes, or
- Use a CDN ESM URL as a fallback (see project README for details)

## What’s Happening

This example demonstrates:

1. Plugin Initialization: creating and enabling `ArtoolkitPlugin`
2. Worker Communication: the plugin starts a Worker for detection
3. Pattern Loading: `plugin.loadMarker('/examples/simple-marker/data/patt.hiro', 1)`
4. Event Handling:
    - `ar:workerReady` — Worker initialized
    - `ar:markerFound` — First detection of a marker
    - `ar:markerUpdated` — Subsequent tracking updates
    - `ar:markerLost` — Marker no longer visible
    - `ar:getMarker` — Raw ARToolKit getMarker payload (type, matrix, marker fields)

## Pattern File

The `data/patt.hiro` file is a standard ARToolKit pattern. You can replace it with your own pattern and update the URL accordingly.

## Code Overview

Key parts of the example:

```javascript
// Create plugin instance with worker enabled and explicit module/params URLs
const plugin = new ArtoolkitPlugin({
  worker: true,
  artoolkitModuleUrl: '/node_modules/@ar-js-org/artoolkit5-js/dist/ARToolkit.js',
  cameraParametersUrl: '/examples/simple-marker/data/camera_para.dat'
});

// Initialize and enable
await plugin.init(core);
await plugin.enable();

// Load a pattern marker
const result = await plugin.loadMarker('/examples/simple-marker/data/patt.hiro', 1);
console.log(`Marker loaded with ID: ${result.markerId}`);
```

## Troubleshooting

- Worker not loading?
    - Ensure you’re serving via HTTP/HTTPS from the repository root (not `file://`)
    - Check console for module resolution/CORS errors
- Module import errors?
    - Make sure `/node_modules/@ar-js-org/artoolkit5-js/dist/ARToolkit.js` is reachable, or use a CDN URL
- Marker not loading?
    - Verify the pattern file path is correct and accessible
    - Ensure the worker is ready before calling `loadMarker()`
- No detections?
    - Click “Start Camera” before “Load Marker”
    - Ensure good lighting and the correct marker
    - Increase confidence tolerance if needed (see README options)

## Browser Support

This example requires:
- ES modules
- Web Workers
- Modern browser (Chrome 80+, Firefox 75+, Safari 13.1+, Edge 80+)