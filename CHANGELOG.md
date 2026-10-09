# Changelog

All notable changes to `@ar-js-org/arjs-plugin-artoolkit` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/). Before 1.0,
a minor version may break the API; every breaking change is marked
**Breaking** and says what consumers must change. The README's "Upgrading to …"
sections cover each breaking release in more detail.

## [Unreleased]

### Added

- `ar:camera` `{ projectionMatrix, width, height, timestamp }`: the camera
  projection matrix ARToolKit computes from `camera_para.dat`, which pairs with
  the marker events' `matrix`. It is emitted once, when the first frame creates
  the detector state. `plugin.getProjectionMatrix()` returns the same values to
  a renderer that starts later. Without it, a 3D renderer had no way to overlay
  content on the marker (#57).

## [0.3.0] - 2026-10-08

No breaking API changes.

### Added

- Barcode (matrix code) markers: `plugin.trackBarcode(barcodeId, size)`. If
  `detectionMode` cannot detect barcodes, it is switched to the closest mode
  that can, with a warning (#24).
- Detector options: `detectionMode`, `matrixCodeType` and `detector` (other
  artoolkit5-ts `DetectorOptions`) in the constructor, and
  `plugin.configureDetector(opts)` at runtime. Only the keys passed change
  (#25).
- `minConfidence` accepts `{ pattern, barcode }`; a number still applies to
  both families.
- The `simple-marker` example tracks 3x3 barcodes 0 and 5 next to the pattern
  markers.

### Changed

- `ar:markerLost` honours `lostThreshold` as a count of consecutive processed
  frames without the marker. In 0.2.0 it behaved as a 1-second timer, because
  artoolkit5-ts reports a loss only once (#38). `frameDurationMs` now only
  sizes the stall guard, which reports every marker lost when frames stop
  being processed at all.
- Confidence filtering happens inside artoolkit5-ts, per marker family.
- `trackBarcode` and `configureDetector` called before the first frame settle
  once the detector initialises and applies them, so a refused option rejects
  its own call.
- Detector options are applied one key at a time: a refused key fails alone,
  and `minConfidence` changes only the families given.

### Fixed

- A failed WASM or camera-parameter load fires `ar:workerError` at once, instead
  of surfacing only as `loadMarker request timed out` ten seconds later.
  `wasmUrl` is documented as effectively required (#40).
- `ImageBitmap` is closed on every plugin and worker path (#28).
- Stopping the worker rejects pending `loadMarker`, `trackBarcode` and
  `configureDetector` calls at once instead of at their timeout.
- An invalid constructor option no longer prevents queued barcodes from being
  registered.
- A frame the worker cannot analyse (no `ImageBitmap`) no longer counts as a
  missed frame, so it cannot fire `ar:markerLost` for markers still in view
  (#46).

### Development

- ESLint flat config, so `npm run lint` works (#26).
- `.prettierrc` with `endOfLine: auto`, so `format:check` passes on Windows
  (#27).
- Tests for the worker's message protocol and a plugin-to-worker round trip
  (part of #29).
- Dev dependencies updated within their major versions.
- `release.yml` runs on tag pushes only. Its manual dispatch named the release
  after a `tag` input but built the dispatched ref (#39).

## [0.2.0] - 2026-10-05

The detection engine moves from artoolkit5-js to
[artoolkit5-ts](https://github.com/AR-js-org/artoolkit5-ts).

### Added

- `vertex` on `ar:markerFound` and `ar:markerUpdated`: the detected square's
  four corners in frame pixel coordinates.
- `dir` on the same events: the marker's rotation (0 to 3), which identifies
  which corner of `vertex` is the printed marker's top-left.
- `type` on every marker event: `"pattern"` or `"barcode"`.
- `minConfidence` as a public constructor option (default 0.6, unchanged).

### Changed

- **Breaking:** event payloads renamed `id` → `markerId` and
  `poseMatrix` → `matrix`.
- **Breaking:** `artoolkitModuleUrl` renamed `wasmUrl`, pointing at the
  `artoolkit5.wasm` binary.
- **Breaking:** `getMarkerState(id, type)` takes the marker family; `type`
  defaults to `"pattern"`.
- Pattern and barcode markers are tracked separately, so pattern 0 and
  barcode 0 are different markers.
- `ar:markerLost` is debounced over consecutive missed frames.
- At most one frame is in flight to the worker; frames arriving meanwhile are
  dropped and their `ImageBitmap` closed.
- The published package contains only `dist` and `types`, and is published
  from CI with npm provenance.

### Removed

- **Breaking:** `ar:getMarker`. Use the marker events instead.
- **Breaking:** `corners`, which was malformed. Corner data is `vertex`.
- **Breaking:** `wasmBaseUrl`, which configured nothing.
- **Breaking:** the Node `worker_threads` path, which never worked. Detection
  is browser-only; `worker: false` still runs the lifecycle under Node.

### Fixed

- Every `processFrame` is acknowledged, so frame submission cannot stall.
- `loadMarker` no longer uses freed detector state or hangs forever, and
  recovers after an initialisation outage.
- The worker is terminated after its dispose message has been processed.

## [0.1.3] - 2025-12-10

### Fixed

- The published package contains the built artifacts.
- Release and publish workflows: tag pattern, Husky disabled in CI, release
  assets zipped with their directory structure.

## [0.1.2] - 2025-11-28

Tagged on GitHub, not published to npm.

### Changed

- Documentation improvements.

## [0.1.1] - 2025-11-26

Tagged on GitHub, not published to npm.

### Added

- TypeScript declarations.

### Changed

- Dependency updates.

### Removed

- The deprecated smoke-test example.

## [0.1.0] - 2025-11-22

Tagged on GitHub, not published to npm.

### Added

- First release: an AR.js ECS plugin that detects ARToolKit pattern markers
  in a Web Worker, with frames transferred as `ImageBitmap`, built on
  artoolkit5-js.
- Vite ESM library build.
- `ARTOOLKIT_PLUGIN_VERSION` and `plugin.version`.

[Unreleased]: https://github.com/AR-js-org/arjs-plugin-artoolkit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/AR-js-org/arjs-plugin-artoolkit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AR-js-org/arjs-plugin-artoolkit/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/AR-js-org/arjs-plugin-artoolkit/compare/0.1.2...v0.1.3
[0.1.2]: https://github.com/AR-js-org/arjs-plugin-artoolkit/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/AR-js-org/arjs-plugin-artoolkit/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/AR-js-org/arjs-plugin-artoolkit/releases/tag/0.1.0
