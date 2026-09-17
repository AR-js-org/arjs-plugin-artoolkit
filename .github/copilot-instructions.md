# GitHub Copilot instructions

The canonical instructions for this repository are in
[AGENTS.md](../AGENTS.md). Read it for the full architecture, worker protocol
and conventions. The essentials are repeated here because Copilot does not
follow includes.

## Summary

`@ar-js-org/arjs-plugin-artoolkit` is the marker-detection plugin for
AR.js-next. It detects ARToolKit markers in camera frames inside a Web Worker
and emits marker lifecycle events on the engine event bus.

Three modules: `src/plugin.js` (lifecycle, marker registry, events),
`src/detector/artoolkit-detector.js` (DOM-free wrapper over artoolkit5-ts,
pixels in and poses out), `src/worker/worker.js` (message pump). Keep DOM and
`postMessage` concerns in the worker; keep the detector free of both.

Events are `ar:markerFound`, `ar:markerUpdated` and `ar:markerLost`, with
payloads `{ markerId, type, matrix, confidence, timestamp }`. `matrix` is a
`Float32Array(16)`, 4x4 column-major, WebGL-ready. `type` is `"pattern"` or
`"barcode"`; the two families have independent ID registries, so marker state is
keyed by type and ID together, never by ID alone.

ESM only. JSDoc on public API. prettier formats everything. Vitest with jsdom
for tests; never load real WASM in a unit test. Conventional commit prefixes.
Branch flow is feature branch → `dev` → `main`.
