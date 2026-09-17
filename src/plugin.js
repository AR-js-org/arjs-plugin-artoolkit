/**
 * @fileoverview ARToolKit Plugin - Core implementation
 *
 * Manages the lifecycle of marker-based AR tracking using ARToolKit.
 * Supports web worker-based detection, marker state tracking, and event emission.
 * Works in both browser (Web Worker) and Node.js (worker_threads) environments.
 *
 * @module plugin
 */

/**
 * Plugin version string, injected at build time by Vite's define feature.
 * In development/test environments without the build define, defaults to 'unknown'.
 *
 * @type {string}
 * @constant
 */
const ARTOOLKIT_PLUGIN_VERSION =
  typeof __ARTOOLKIT_PLUGIN_VERSION__ !== "undefined"
    ? __ARTOOLKIT_PLUGIN_VERSION__
    : "unknown";

export { ARTOOLKIT_PLUGIN_VERSION };

/**
 * ARToolKit Plugin for marker-based augmented reality tracking.
 *
 * This plugin integrates ARToolKit marker detection into AR.js, managing:
 * - Plugin lifecycle (init, enable, disable, dispose)
 * - Web Worker-based detection for off-main-thread processing
 * - Frame processing via ImageBitmap transfer (zero-copy in browsers)
 * - Marker state tracking and lost-marker detection
 * - Event emission for marker lifecycle (found/updated/lost)
 *
 * @class
 * @param {Object} options - Configuration options
 * @param {boolean} [options.worker=true] - Enable worker-based detection
 * @param {number} [options.lostThreshold=5] - Frames before marking a marker as lost
 * @param {number} [options.frameDurationMs=200] - Milliseconds per frame (for lost calculation)
 * @param {number} [options.sweepIntervalMs=100] - Interval for running lost-marker sweep
 * @param {string} [options.artoolkitModuleUrl] - Custom URL for ARToolKit module
 * @param {string} [options.cameraParametersUrl] - Camera calibration parameters URL
 * @param {string} [options.wasmBaseUrl] - Base URL for ARToolKit WASM files
 *
 * @example
 * const plugin = new ArtoolkitPlugin({
 *   worker: true,
 *   lostThreshold: 10,
 *   cameraParametersUrl: '/path/to/camera_para.dat'
 * });
 * await plugin.init(engineCore);
 * await plugin.enable();
 *
 * @fires ar:markerFound - When a marker is first detected
 * @fires ar:markerUpdated - When a tracked marker's pose updates
 * @fires ar:markerLost - When a marker hasn't been seen for lostThreshold frames
 * @fires ar:workerReady - When the detection worker is initialized
 * @fires ar:workerError - When the worker encounters an error
 *
 * @note Works in both browser (Web Worker) and Node.js (worker_threads) environments
 */
export class ArtoolkitPlugin {
  constructor(options = {}) {
    /** @type {ArtoolkitPluginOptions} */
    this.options = {
      worker: true,
      lostThreshold: 5,
      frameDurationMs: 200,
      sweepIntervalMs: 100,
      artoolkitModuleUrl: undefined,
      cameraParametersUrl: undefined,
      wasmBaseUrl: undefined,
      ...options,
    };
    /** @type {EngineCore | null} */
    this.core = null;
    /** @type {boolean} */
    this.enabled = false;

    // Worker and handlers
    this._worker = null;
    this._onWorkerMessage = this._onWorkerMessage.bind(this);

    // Engine update subscription
    this._onEngineUpdate = this._onEngineUpdate.bind(this);

    // Marker state tracking: Map<id, { lastSeen: number, visible: boolean }>
    this._markers = new Map();

    // Use options consistently
    this.lostThreshold = this.options.lostThreshold;
    this.frameDurationMs = this.options.frameDurationMs;
    this.sweepIntervalMs = this.options.sweepIntervalMs;
    this.workerEnabled = this.options.worker;

    // Pending loadMarker requests: Map<requestId, { resolve, reject }>
    this._pendingMarkerLoads = new Map();
    this._nextLoadRequestId = 0;

    // Track worker readiness (used by examples to avoid UI race)
    this.workerReady = false;

    this.version = ARTOOLKIT_PLUGIN_VERSION;
  }

  /**
   * Initialize the plugin with the engine core.
   *
   * Stores the core reference and prepares the plugin.
   * Heavy initialization (worker setup) is deferred to enable().
   *
   * @param {Object} core - Engine core with eventBus
   * @param {Object} core.eventBus - Event bus for plugin communication
   * @returns {Promise<ArtoolkitPlugin>} This plugin instance
   */
  async init(core) {
    this.core = core;
    // Nothing heavy here; defer worker setup to enable()
    console.log(
      `[ArtoolkitPlugin] ${this.version} Initialized with core`,
      core,
    );
    return this;
  }

  /**
   * Enable the plugin and start marker detection.
   *
   * - Subscribes to engine:update events for frame processing
   * - Starts the detection worker (if workerEnabled)
   * - Begins marker sweep interval for lost-marker detection
   *
   * @returns {Promise<ArtoolkitPlugin>} This plugin instance
   * @throws {Error} If plugin not initialized via init()
   */
  async enable() {
    if (!this.core) throw new Error("Plugin not initialized");
    if (this.enabled) return this;
    this.enabled = true;

    // subscribe to engine update to send frames to worker
    this.core.eventBus.on("engine:update", this._onEngineUpdate);

    // start worker if configured
    if (this.workerEnabled) {
      await this._startWorker();
    }

    // start a simple interval to sweep lost markers by time computed from frameDurationMs
    this._sweepInterval = setInterval(
      () => this._sweepMarkers(),
      this.sweepIntervalMs,
    );
    return this;
  }

  /**
   * Disable the plugin and stop marker detection.
   *
   * - Unsubscribes from engine:update events
   * - Stops and terminates the detection worker
   * - Clears the marker sweep interval
   *
   * @returns {Promise<ArtoolkitPlugin>} This plugin instance
   */
  async disable() {
    if (!this.enabled) return this;
    this.enabled = false;

    this.core.eventBus.off("engine:update", this._onEngineUpdate);

    if (this._worker) {
      this._stopWorker();
    }

    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }

    return this;
  }

  /**
   * Dispose of the plugin and clean up resources.
   *
   * Alias for disable() - stops detection and terminates worker.
   *
   * @returns {Promise<ArtoolkitPlugin>} This plugin instance
   */
  dispose() {
    return this.disable();
  }

  /**
   * Engine frame update handler - forwards frames to the worker for processing.
   *
   * Receives frame data from the capture system and sends it to the detection worker.
   * In browsers, uses transferable ImageBitmap for zero-copy performance.
   *
   * @param {Object} frame - Frame data from capture system
   * @param {number} frame.id - Frame identifier
   * @param {number} frame.timestamp - Frame timestamp
   * @param {ImageBitmap} [frame.imageBitmap] - Browser-only transferable image data
   * @param {number} frame.width - Frame width in pixels
   * @param {number} frame.height - Frame height in pixels
   * @param {*} [frame.sourceRef] - Optional reference to source
   *
   * @private
   * @note After ImageBitmap transfer, the main thread's bitmap is neutered and cannot be reused
   */
  _onEngineUpdate(frame) {
    // frame is expected to be an object provided by the capture system, e.g.:
    // { id: number, timestamp, imageBitmap?, width, height, sourceRef }
    if (!frame) return;

    // If the frame contains an ImageBitmap (browser), transfer it to the worker for zero-copy processing.
    if (this._worker && frame.imageBitmap) {
      try {
        // Browser Worker supports transfer list; Node worker_threads supports postMessage but not ImageBitmap.
        if (typeof Worker !== "undefined") {
          // Browser: use transferable ImageBitmap
          // The browser worker will receive event.data.payload.imageBitmap
          this._worker.postMessage(
            {
              type: "processFrame",
              payload: {
                frameId: frame.id,
                imageBitmap: frame.imageBitmap,
                width: frame.width,
                height: frame.height,
              },
            },
            // transfer list: ImageBitmap is transferable
            [frame.imageBitmap],
          );
          // After transfer, the main thread's ImageBitmap is neutered; consumer should not reuse it.
        } else {
          // Node: ImageBitmap isn't available/transferable; fall back to sending metadata or ArrayBuffer if provided
          this._worker.postMessage({
            type: "processFrame",
            payload: {
              frameId: frame.id,
              width: frame.width,
              height: frame.height,
            },
          });
        }
      } catch (err) {
        console.warn(
          "Artoolkit worker postMessage (ImageBitmap) failed, falling back to frameId only",
          err,
        );
        try {
          this._worker.postMessage({
            type: "processFrame",
            payload: { frameId: frame.id },
          });
        } catch (e) {
          console.warn("worker postMessage failed", e);
        }
      }
      return;
    }

    // No ImageBitmap: send lighter payload as before (frameId)
    if (this._worker) {
      try {
        this._worker.postMessage({
          type: "processFrame",
          payload: { frameId: frame.id },
        });
      } catch (err) {
        console.warn("Artoolkit worker postMessage failed", err);
      }
    }
  }

  /**
   * Start the detection worker (cross-platform).
   *
   * Creates and initializes a Web Worker (browser) or worker_threads.Worker (Node.js).
   * Attaches message handlers and sends initial configuration to the worker.
   *
   * **Browser:** Uses `new Worker(new URL(...), { type: 'module' })`
   * **Node.js:** Uses `worker_threads.Worker` with file path resolution
   *
   * Sends init message with:
   * - artoolkitModuleUrl: Custom ARToolKit module URL
   * - cameraParametersUrl: Camera calibration parameters
   * - wasmBaseUrl: Base URL for WASM files
   *
   * Includes watchdog timer to resend init if worker doesn't respond within 500ms.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _startWorker() {
    if (this._worker) return;

    // Browser environment: global Worker exists
    if (typeof Worker !== "undefined") {
      // Works in browsers and bundlers that support new URL(...) for workers
      this._worker = new Worker(
        new URL("./worker/worker.js", import.meta.url),
        { type: "module" },
      );
    } else {
      // Node environment: use worker_threads.Worker
      const { Worker: NodeWorker } = await import("node:worker_threads");
      const workerUrl = new URL("./worker/worker.js", import.meta.url);
      const { fileURLToPath } = await import("node:url");
      const workerPath = fileURLToPath(workerUrl);
      this._worker = new NodeWorker(workerPath, { type: "module" });
    }

    // Attach message handler (same for both environments)
    if (this._worker.addEventListener) {
      this._worker.addEventListener("message", this._onWorkerMessage);
    } else if (this._worker.on) {
      this._worker.on("message", this._onWorkerMessage);
    }

    // If worker supports postMessage init, send init
    try {
      this._worker.postMessage?.({
        type: "init",
        payload: {
          moduleUrl: this.options.artoolkitModuleUrl || null,
          cameraParametersUrl: this.options.cameraParametersUrl || null,
          wasmBaseUrl: this.options.wasmBaseUrl || null,
        },
      });
      // Watchdog: if 'ready' wasn’t received shortly, resend a no-op init once
      setTimeout(() => {
        if (!this.workerReady) {
          try {
            this._worker?.postMessage?.({ type: "init", payload: {} });
          } catch {}
        }
      }, 500);
    } catch (e) {
      // ignore
    }
  }

  /**
   * Stop and terminate the detection worker.
   *
   * Removes message event handlers and terminates the worker thread.
   * Works for both browser Workers and Node.js worker_threads.
   *
   * @private
   */
  _stopWorker() {
    if (!this._worker) return;

    // Remove handler
    if (this._worker.removeEventListener) {
      this._worker.removeEventListener("message", this._onWorkerMessage);
    } else if (this._worker.off) {
      this._worker.off("message", this._onWorkerMessage);
    }

    try {
      if (typeof Worker !== "undefined") {
        this._worker.terminate();
      } else {
        this._worker.terminate?.();
      }
    } catch (e) {
      // ignore
    }
    this._worker = null;
  }

  /**
   * Build the registry key for a marker.
   *
   * Pattern and barcode markers have independent ID registries in
   * artoolkit5-ts — both start at 0 — so the family is part of the identity.
   * Keying on the bare ID would make pattern 3 and barcode 3 the same marker.
   *
   * @param {number} id - Marker ID within its family
   * @param {string} type - Marker family, 'pattern' or 'barcode'
   * @returns {string} Registry key
   * @private
   */
  _markerKey(id, type) {
    return `${type}:${id}`;
  }

  /**
   * Apply detection results and emit marker events.
   *
   * A marker not currently visible emits `ar:markerFound`; one already visible
   * emits `ar:markerUpdated`.
   *
   * @param {Array<Object>} detected - Poses from the worker
   * @param {number} detected[].id - Marker ID within its family
   * @param {string} detected[].type - 'pattern' or 'barcode'
   * @param {number} detected[].confidence - Match confidence, 0-1
   * @param {Float32Array} detected[].matrixGL - 4x4 column-major pose
   * @private
   */
  _applyDetections(detected) {
    if (!Array.isArray(detected)) return;

    for (const pose of detected) {
      const { id, type } = pose || {};
      if (id === null || id === undefined || !type) continue;

      const now = Date.now();
      const key = this._markerKey(id, type);
      const matrix =
        pose.matrixGL instanceof Float32Array
          ? pose.matrixGL
          : new Float32Array(pose.matrixGL || 16);
      const confidence = pose.confidence ?? 0;

      const prev = this._markers.get(key);
      const payload = {
        markerId: id,
        type,
        matrix,
        confidence,
        timestamp: now,
      };

      if (!prev || !prev.visible) {
        this._markers.set(key, { lastSeen: now, visible: true, id, type });
        this.core?.eventBus?.emit("ar:markerFound", payload);
      } else {
        prev.lastSeen = now;
        this._markers.set(key, prev);
        this.core?.eventBus?.emit("ar:markerUpdated", payload);
      }
    }
  }

  /**
   * Emit `ar:markerLost` for markers the detector reports as gone.
   *
   * A lost report for an untracked marker is ignored: confidence filtering can
   * drop a detection the library still considers tracked, so the plugin may
   * never have seen it.
   *
   * @param {Array<Object>} lost - Entries of `{ id, type }`
   * @private
   */
  _applyLost(lost) {
    if (!Array.isArray(lost)) return;

    for (const entry of lost) {
      const { id, type } = entry || {};
      if (id === null || id === undefined || !type) continue;

      const key = this._markerKey(id, type);
      if (!this._markers.has(key)) continue;

      this._markers.delete(key);
      this.core?.eventBus?.emit("ar:markerLost", {
        markerId: id,
        type,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle messages from the detection worker.
   *
   * Processes different message types and routes them appropriately:
   * - `ready`: Worker initialized, sets workerReady flag
   * - `detectionResult`: Applies detections and losses via _applyDetections/_applyLost
   * - `loadMarkerResult`: Response to loadMarker request, resolves/rejects promise
   * - `error`: Worker error, emits ar:workerError event
   *
   * **Cross-platform handling:**
   * - Browser workers wrap messages in `event.data`
   * - Node.js worker_threads pass raw payload
   *
   * @param {Object|MessageEvent} ev - Message event from worker
   * @param {Object} [ev.data] - Message data (browser workers)
   * @param {string} ev.data.type - Message type
   * @param {*} ev.data.payload - Message payload
   *
   * @private
   */
  _onWorkerMessage(ev) {
    // worker_threads messages arrive as the raw payload; browser workers wrap in event.data
    const data = ev && ev.data !== undefined ? ev.data : ev;
    const { type, payload } = data || {};
    if (type === "ready") {
      console.log("[Plugin] Worker ready");
      this.workerReady = true;
      this.core?.eventBus?.emit("ar:workerReady", {});
    } else if (type === "detectionResult") {
      if (!payload) return;
      this._applyDetections(payload.detected);
      this._applyLost(payload.lost);
    } else if (type === "loadMarkerResult") {
      console.log("[Plugin] Received loadMarkerResult:", payload);
      const { requestId, ok, error, markerId, size } = payload || {};

      if (requestId !== undefined) {
        const pending = this._pendingMarkerLoads.get(requestId);
        if (pending) {
          this._pendingMarkerLoads.delete(requestId);
          if (ok) {
            pending.resolve({ markerId, size });
          } else {
            pending.reject(new Error(error || "Failed to load marker"));
          }
        }
      }
    } else if (type === "error") {
      console.error("Artoolkit worker error", payload);
      this.core?.eventBus?.emit("ar:workerError", payload);
    }
  }

  /**
   * Emit `ar:markerLost` for markers that have gone stale.
   *
   * The detector reports losses itself, on the frame a marker disappears, and
   * that is the primary path. This sweep covers what the detector structurally
   * cannot see: frames that stop arriving at all — a stalled camera, a
   * backgrounded tab, a dead worker — where `processFrame` is never called and
   * a visible marker would otherwise stay visible forever.
   *
   * @private
   */
  _sweepMarkers() {
    const now = Date.now();
    const lostThresholdMs = this.lostThreshold * this.frameDurationMs;

    for (const [key, state] of this._markers.entries()) {
      if (now - (state.lastSeen || 0) <= lostThresholdMs) continue;

      this._markers.delete(key);
      this.core?.eventBus?.emit("ar:markerLost", {
        markerId: state.id,
        type: state.type,
        timestamp: now,
      });
    }
  }

  /**
   * Get the current tracking state of a marker.
   *
   * @param {number} markerId - Marker ID within its family
   * @param {string} [type='pattern'] - Marker family, 'pattern' or 'barcode'
   * @returns {Object|null} State with `lastSeen`, `visible`, `id` and `type`,
   *   or null if the marker is not tracked
   *
   * @example
   * const state = plugin.getMarkerState(42, 'pattern');
   * if (state && state.visible) console.log('last seen', state.lastSeen);
   */
  getMarkerState(markerId, type = "pattern") {
    return this._markers.get(this._markerKey(markerId, type)) || null;
  }

  /**
   * Load a pattern marker from a URL
   * @param {string} patternUrl - URL to the pattern file (absolute or repo-relative)
   * @param {number} size - Size of the marker in world units (default: 1)
   * @returns {Promise<{markerId: number, size: number}>} - Resolves with marker info when loaded
   */
  async loadMarker(patternUrl, size = 1) {
    if (!this._worker) {
      throw new Error(
        "Worker not available. Ensure plugin is enabled and worker is running.",
      );
    }

    console.log(`[Plugin] Loading marker: ${patternUrl} with size ${size}`);

    return new Promise((resolve, reject) => {
      const requestId = this._nextLoadRequestId++;
      this._pendingMarkerLoads.set(requestId, { resolve, reject });

      // Send loadMarker message to worker
      try {
        this._worker.postMessage({
          type: "loadMarker",
          payload: { patternUrl, size, requestId },
        });
      } catch (err) {
        this._pendingMarkerLoads.delete(requestId);
        reject(new Error(`Failed to send loadMarker message: ${err.message}`));
      }

      // Set a timeout to prevent hanging promises
      setTimeout(() => {
        if (this._pendingMarkerLoads.has(requestId)) {
          this._pendingMarkerLoads.delete(requestId);
          reject(new Error("loadMarker request timed out"));
        }
      }, 10000); // 10 second timeout
    });
  }
}

/**
 * @typedef {import("../types/plugin").ArtoolkitPluginOptions} ArtoolkitPluginOptions
 * @typedef {import("../types/plugin").EngineCore} EngineCore
 * @typedef {import("../types/plugin").EngineEventBus} EngineEventBus
 */
