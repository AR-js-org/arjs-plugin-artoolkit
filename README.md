# @ar-js-org/arjs-plugin-artoolkit

ARToolKit marker detection plugin for AR.js core with WebAssembly support.

## Features

- **Web Worker-based detection** - Runs marker detection in a separate thread for better performance
- **ImageBitmap support** - Zero-copy frame transfer from main thread to worker (browser)
- **Cross-platform** - Works in browsers (Worker) and Node.js (worker_threads)
- **ARToolKit WASM integration** - Supports simple square marker detection
- **Event-driven API** - Emits marker lifecycle events (found/updated/lost)

## Installation

```bash
npm install @ar-js-org/arjs-plugin-artoolkit
```

## ARToolKit WASM Setup

The plugin requires ARToolKit WASM binaries for real marker detection. Without them, the plugin runs in stub mode.

### Option 1: Using artoolkit5-js (Recommended)

```bash
npm install artoolkit5-js
```

The loader will automatically detect and use the WASM module.

### Option 2: Manual WASM Binary

Place the `artoolkit.wasm` file in `src/worker/artoolkit/`:

```
src/worker/artoolkit/
  ├── loader.js
  ├── artoolkit.wasm  # <- Place WASM binary here
  └── README.md
```

See [src/worker/artoolkit/README.md](src/worker/artoolkit/README.md) for more details.

### Fallback Mode

If WASM is not available:
- The plugin will initialize successfully with console warnings
- Detection will return empty results
- All other functionality works normally

## Usage

### Basic Integration

Register with the Engine plugin manager:

```js
import { ArtoolkitPlugin } from '@ar-js-org/arjs-plugin-artoolkit';

const plugin = new ArtoolkitPlugin({
  worker: true,              // Enable worker-based detection (default: true)
  lostThreshold: 5,          // Frames before marker considered lost
  frameDurationMs: 100       // Expected frame duration in ms
});

engine.pluginManager.register('artoolkit', plugin);
await engine.pluginManager.enable('artoolkit');
```

### Event Handling

The plugin emits events on the engine event bus:

```js
// Marker first detected
engine.eventBus.on('ar:markerFound', (data) => {
  console.log('Marker found:', data.id);
  console.log('Pose matrix:', data.poseMatrix); // Float32Array[16]
  console.log('Confidence:', data.confidence);  // 0.0 - 1.0
  console.log('Corners:', data.corners);        // [{x, y}, ...]
});

// Marker updated (tracking)
engine.eventBus.on('ar:markerUpdated', (data) => {
  // Same data structure as markerFound
});

// Marker lost (not detected for lostThreshold frames)
engine.eventBus.on('ar:markerLost', (data) => {
  console.log('Marker lost:', data.id);
});

// Worker ready
engine.eventBus.on('ar:workerReady', () => {
  console.log('Detection worker initialized');
});

// Worker errors
engine.eventBus.on('ar:workerError', (error) => {
  console.error('Worker error:', error);
});
```

### Sending Frames to Plugin

The plugin subscribes to `engine:update` events and expects frames with ImageBitmap:

```js
// Capture from video element
const video = document.getElementById('video');
const imageBitmap = await createImageBitmap(video);

// Send to plugin via engine update
engine.eventBus.emit('engine:update', {
  id: frameId,
  timestamp: Date.now(),
  imageBitmap: imageBitmap,  // Transferred to worker (zero-copy)
  width: imageBitmap.width,
  height: imageBitmap.height
});
```

**Important:** The ImageBitmap is transferred to the worker and cannot be used after the emit. The worker will automatically close it after processing.

## Examples

### Simple Marker Detection

A complete webcam-based marker detection example is available in `examples/simple-marker/`:

```bash
# Start a local server (requires Node.js)
npx http-server examples/simple-marker -p 8080

# Or use Python
python3 -m http.server 8080 --directory examples/simple-marker
```

Then open http://localhost:8080 in your browser.

The example demonstrates:
- Webcam capture with getUserMedia
- ImageBitmap creation from video frames
- Frame submission to the plugin
- Event handling and console output
- Status monitoring

See [examples/simple-marker/script.js](examples/simple-marker/script.js) for the implementation.

## Development

### Install Dependencies

```bash
npm install
```

### Run Tests

```bash
npm test
```

### Build

```bash
npm run build
```

## Architecture

### Detection Pipeline (Browser)

```
Video/Camera
  ↓ createImageBitmap()
ImageBitmap
  ↓ postMessage (transfer)
Worker: OffscreenCanvas
  ↓ drawImage()
Worker: ImageData
  ↓ ARToolKit WASM
Worker: Detections
  ↓ postMessage
Plugin: Event Emission
```

### Worker Implementation

- **Platform-agnostic**: Supports both browser Worker and Node worker_threads
- **OffscreenCanvas**: Used for ImageBitmap → ImageData conversion
- **Resource management**: Automatically closes ImageBitmap after processing
- **Defensive**: Falls back gracefully if WASM is not available

### Plugin Features

- **Marker lifecycle tracking**: Maintains state for found/updated/lost transitions
- **Configurable thresholds**: Adjustable lost detection timing
- **Zero-copy transfer**: Uses ImageBitmap transferables in browsers
- **Cross-platform**: Works in both browser and Node.js environments

## API Reference

### ArtoolkitPlugin

#### Constructor Options

```typescript
{
  worker?: boolean;           // Enable worker (default: true)
  lostThreshold?: number;     // Frames before lost (default: 5)
  frameDurationMs?: number;   // Frame duration (default: 200ms)
  sweepIntervalMs?: number;   // Lost marker check interval (default: 100ms)
}
```

#### Methods

- `async init(core)` - Initialize plugin with engine core
- `async enable()` - Enable plugin and start worker
- `async disable()` - Disable plugin and stop worker
- `dispose()` - Alias for disable()
- `getMarkerState(markerId)` - Get current state of a marker

#### Events Emitted

- `ar:workerReady` - Worker initialized and ready
- `ar:markerFound` - New marker detected
- `ar:markerUpdated` - Tracked marker updated
- `ar:markerLost` - Marker no longer detected
- `ar:workerError` - Worker error occurred

## Troubleshooting

### No detections

1. Check browser console for WASM loading warnings
2. Verify WASM binary is in correct location (see Setup)
3. Ensure camera feed is active and markers are visible
4. Check marker quality and lighting conditions

### Worker not starting

1. Verify browser supports Web Workers and ES modules
2. Check for CSP (Content Security Policy) restrictions
3. Ensure script is served over HTTPS or localhost

### Performance issues

1. Reduce frame rate (increase timeout in example)
2. Lower camera resolution
3. Check CPU usage - detection is compute-intensive

## License

MIT

## Contributing

Contributions welcome! Please follow the existing code style and add tests for new features.