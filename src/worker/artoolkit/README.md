# ARToolKit WASM Integration

This directory contains the ARToolKit WASM loader for marker detection.

## Setup

To enable real marker detection, you need to provide the ARToolKit WASM binary:

### Option 1: Using artoolkit5-js (npm package)

```bash
npm install artoolkit5-js
```

The loader will attempt to load the WASM module from the installed package.

### Option 2: Manual WASM binary

Place the `artoolkit.wasm` file in this directory:

```
src/worker/artoolkit/
  ├── loader.js
  ├── artoolkit.wasm  # <- Place WASM binary here
  └── README.md
```

You can obtain the WASM binary from:
- [ARToolKit5 repository](https://github.com/artoolkitx/artoolkit5)
- Pre-built binaries from artoolkit5-js package
- Build from source following ARToolKit5 documentation

### Option 3: CDN

Configure the loader to fetch the WASM binary from a CDN by modifying `loader.js`.

## Fallback Behavior

If the WASM binary is not available, the detector will run in stub mode:
- Initialization will succeed with warnings
- Detection calls will return empty results
- Console will show warnings indicating WASM is not loaded

This allows the plugin to function without errors while WASM setup is pending.

## Detection API

The loader exports:
- `createDetector(options)` - Creates and initializes a detector instance
- `ARToolKitDetector` - Detector class for advanced usage

Detection pipeline:
1. ImageBitmap → OffscreenCanvas
2. OffscreenCanvas → ImageData
3. ImageData → ARToolKit detector
4. Returns: Array of markers with { id, confidence, poseMatrix, corners }
