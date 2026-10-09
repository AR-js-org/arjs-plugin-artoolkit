/**
 * @fileoverview ARToolKit Plugin - Core implementation
 *
 * Manages the lifecycle of marker-based AR tracking using ARToolKit.
 * Supports web worker-based detection, marker state tracking, and event emission.
 * Detection is browser-only (needs Worker and OffscreenCanvas); elsewhere the
 * plugin still runs its lifecycle without detecting markers.
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

/** Corners per detected square. ARToolKit squares always have four. */
const SQUARE_CORNERS = 4;

/** `dir` counts quarter turns, so it is one of 0, 1, 2, 3. */
const MAX_DIR = 3;

/**
 * The square's corners if the detector reported a usable set, otherwise
 * undefined.
 *
 * Checked rather than forwarded because this is where the event contract is
 * established, and every other field in the payload is already normalised here -
 * `matrixGL` is coerced to a Float32Array and `confidence` defaults to 0. Passing
 * these two through raw was the odd one out.
 *
 * Deliberately shallow: the length is checked, the pairs inside are not. The
 * realistic failure is the field being *absent*, from a detector that was
 * bypassed or a stale build. Corrupt inner pairs would mean artoolkit5-ts itself
 * is misbehaving, and quietly dropping the field would make that harder to
 * diagnose rather than easier.
 *
 * @param {unknown} vertex - Whatever the worker reported.
 * @returns {Array<[number, number]>|undefined} The corners, or undefined.
 */
function usableVertex(vertex) {
  return Array.isArray(vertex) && vertex.length === SQUARE_CORNERS
    ? vertex
    : undefined;
}

/**
 * The marker's rotation if the detector reported a usable one, otherwise
 * undefined.
 *
 * Range-checked, not just type-checked: `dir` exists to be used as
 * `vertex[(4 - dir) % 4]`, and a value outside 0-3 indexes outside the square.
 * A negative `dir` is the nastier case - `(4 - -1) % 4` is 1, a valid index and
 * the wrong corner, so it would fail silently rather than loudly.
 *
 * @param {unknown} dir - Whatever the worker reported.
 * @returns {number|undefined} The rotation 0-3, or undefined.
 */
function usableDir(dir) {
  return Number.isInteger(dir) && dir >= 0 && dir <= MAX_DIR ? dir : undefined;
}

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
 * @param {number} [options.lostThreshold=5] - Consecutive processed frames a tracked marker must be absent from before it is marked lost (see _applyMisses); skipped frames do not count. Times frameDurationMs, it is also how long the plugin may go without an analysed frame before the stall guard reports every tracked marker lost (see _sweepMarkers): frames acknowledged as skipped do not reset that timer, so markers can be reported lost while skipped frames keep arriving
 * @param {number} [options.frameDurationMs=200] - Expected milliseconds per processed frame. Only used for the stall guard: when no frame has been processed for `lostThreshold * frameDurationMs`, every tracked marker is reported lost (see _sweepMarkers)
 * @param {number} [options.sweepIntervalMs=100] - Interval for running the stall guard
 * @param {string} [options.cameraParametersUrl] - Camera calibration parameters URL
 * @param {string} options.wasmUrl - URL of `artoolkit5.wasm`. **Effectively required**: the library build does not ship the binary, and without it the default resolves relative to the worker chunk and 404s. Point it at `@ar-js-org/artoolkit5-wasm/dist/artoolkit5.wasm` (e.g. with Vite's `?url` import). A failed load is reported through `ar:workerError`.
 * @param {number|{pattern?: number, barcode?: number}} [options.minConfidence=0.6] - Drop detections below this confidence (0-1), for both families or per family
 * @param {string} [options.detectionMode] - artoolkit5-ts detection mode: 'color' (engine default), 'mono', 'matrix', 'color_and_matrix' or 'mono_and_matrix'. Switched automatically to a matrix-capable mode by {@link ArtoolkitPlugin#trackBarcode}
 * @param {string} [options.matrixCodeType] - Barcode dictionary, e.g. '3x3' (engine default), '4x4', '4x4_BCH_13_9_3'
 * @param {Object} [options.detector] - Other artoolkit5-ts `DetectorOptions` passed through as is: `threshold`, `thresholdMode`, `labelingMode`, `imageProcMode`, `patternRatio`, `nearPlane`, `farPlane`
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
 * @fires ar:markerLost - When a tracked marker has been absent from lostThreshold consecutive processed frames, or no frame has been analysed for lostThreshold × frameDurationMs (frames stopped, or all skipped)
 * @fires ar:workerReady - When the detection worker is initialized
 * @fires ar:workerError - When the worker encounters an error
 * @fires ar:camera - With the camera projection, once the first frame reaches the detector and again when nearPlane or farPlane change
 *
 * @note Detection is browser-only (needs Worker and OffscreenCanvas); elsewhere the plugin still runs its lifecycle without detecting markers
 */
export class ArtoolkitPlugin {
  constructor(options = {}) {
    /** @type {ArtoolkitPluginOptions} */
    this.options = {
      worker: true,
      lostThreshold: 5,
      frameDurationMs: 200,
      sweepIntervalMs: 100,
      cameraParametersUrl: undefined,
      wasmUrl: undefined,
      minConfidence: 0.6,
      detectionMode: undefined,
      matrixCodeType: undefined,
      detector: undefined,
      ...options,
    };
    /** @type {EngineCore | null} */
    this.core = null;
    /** @type {boolean} */
    this.enabled = false;

    // Worker and handlers
    this._worker = null;
    this._onWorkerMessage = this._onWorkerMessage.bind(this);

    // True while a processFrame message has been posted to the worker and no
    // detectionResult/error has acknowledged it yet. Backpressure: gates
    // _onEngineUpdate so at most one frame is ever in flight, instead of
    // flooding the worker's unbounded FIFO postMessage queue. See
    // _onEngineUpdate for the failure this prevents.
    this._frameInFlight = false;

    // Engine update subscription
    this._onEngineUpdate = this._onEngineUpdate.bind(this);

    // Marker state tracking, keyed `${type}:${id}` because pattern and barcode
    // markers have independent ID registries: Map<string, { lastSeen: number,
    // visible: boolean, consecutiveMisses: number, id: number, type: string }>
    this._markers = new Map();

    // Use options consistently
    this.lostThreshold = this.options.lostThreshold;
    this.frameDurationMs = this.options.frameDurationMs;
    this.sweepIntervalMs = this.options.sweepIntervalMs;
    this.workerEnabled = this.options.worker;

    // Pending worker requests (loadMarker, trackBarcode, configure):
    // Map<requestId, { resolve, reject }>
    this._pendingMarkerLoads = new Map();
    this._nextLoadRequestId = 0;

    // When the worker last acknowledged a frame; the stall guard measures
    // from here (see _sweepMarkers).
    this._lastFrameAt = 0;

    // Track worker readiness (used by examples to avoid UI race)
    this.workerReady = false;

    // The camera projection from the worker's `camera` message; null until
    // the first frame has created the detector state.
    this._projectionMatrix = null;

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
   * - Asks the detection worker to shut down (see {@link _stopWorker});
   *   actual termination is deferred by one macrotask, so it has not
   *   necessarily happened yet by the time this resolves
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
   * @note At most one frame is ever in flight (see the backpressure paragraph above the method body)
   */
  _onEngineUpdate(frame) {
    // engine:update carries two shapes on one event name: FramePumpSystem's
    // frames { id, imageBitmap, width, height, timestamp }, and the engine's
    // own tick { deltaTime, context } on every animation frame. Only a frame
    // has anything to analyse. Posting a tick took the in-flight slot until
    // the worker acknowledged it as skipped, dropping camera frames
    // meanwhile (#54).
    if (!frame?.imageBitmap) return;

    // Backpressure. postMessage's queue is FIFO and unbounded: posting one
    // processFrame per engine:update with no regard for whether the worker
    // finished the last one means that once detect() takes longer than the
    // frame interval - which real pattern matching at 60fps does - frames
    // pile up behind the one the worker is currently processing, and every
    // later message queued after them (including loadMarker) waits behind
    // the entire backlog. Observed on real hardware: loadMarker timed out at
    // its 10s client-side limit while its loadMarkerResult was still stuck
    // behind hundreds of queued frames.
    //
    // Fix: drop rather than queue. The newest frame is the one worth a pose;
    // a queued backlog only adds latency to a pose that is already stale by
    // the time it would be computed. The dropped frame's ImageBitmap is
    // closed here because nothing else will - skipping the close leaks a
    // full-resolution bitmap per dropped frame, severe at 60fps.
    if (this._frameInFlight) {
      frame.imageBitmap?.close?.();
      return;
    }

    // Transfer the ImageBitmap to the worker for zero-copy processing.
    if (this._worker) {
      try {
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
        this._frameInFlight = true;
      } catch (err) {
        console.warn(
          "Artoolkit worker postMessage (ImageBitmap) failed, falling back to frameId only",
          err,
        );
        // The transfer did not happen, so the bitmap is still ours to free.
        // close() on an already-detached bitmap is a no-op, so this is safe
        // whichever side of the transfer step the failure was on.
        frame.imageBitmap.close?.();
        try {
          this._worker.postMessage({
            type: "processFrame",
            payload: { frameId: frame.id },
          });
          this._frameInFlight = true;
        } catch (e) {
          console.warn("worker postMessage failed", e);
        }
      }
      return;
    }

    // No worker to hand the bitmap to: nothing else will free it.
    frame.imageBitmap.close?.();
  }

  /**
   * Start the detection worker.
   *
   * Browser-only: detection needs `Worker` and `OffscreenCanvas`. With
   * `worker: false` the plugin runs its lifecycle without detecting anything,
   * which is what `dev/smoke-node.js` exercises under Node.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _startWorker() {
    if (this._worker) return;

    if (typeof Worker === "undefined") {
      console.warn(
        "[ArtoolkitPlugin] Worker is unavailable; detection is browser-only.",
      );
      return;
    }

    this._worker = new Worker(new URL("./worker/worker.js", import.meta.url), {
      type: "module",
    });
    this._worker.addEventListener("message", this._onWorkerMessage);

    this._worker.postMessage({
      type: "init",
      payload: {
        cameraParametersUrl: this.options.cameraParametersUrl || null,
        wasmUrl: this.options.wasmUrl || null,
        minConfidence: this.options.minConfidence,
        detectorOptions: this._detectorOptions(),
      },
    });

    // Watchdog: resend init once if 'ready' did not arrive promptly.
    setTimeout(() => {
      if (!this.workerReady) {
        this._worker?.postMessage({ type: "init", payload: {} });
      }
    }, 500);
  }

  /**
   * The artoolkit5-ts `DetectorOptions` given at construction, without
   * `minConfidence` (sent separately) and without unset keys, so the engine
   * defaults stay in force for anything the caller did not choose.
   *
   * @returns {Object}
   * @private
   */
  _detectorOptions() {
    const { detectionMode, matrixCodeType, detector } = this.options;
    // The top-level options win, but only when set: an unset one must not
    // erase the same key given through `detector`.
    const opts = { ...detector };
    if (detectionMode !== undefined) opts.detectionMode = detectionMode;
    if (matrixCodeType !== undefined) opts.matrixCodeType = matrixCodeType;
    for (const key of Object.keys(opts)) {
      if (opts[key] === undefined) delete opts[key];
    }
    return opts;
  }

  /**
   * Stop and terminate the detection worker.
   *
   * Asks the worker to dispose its ARToolKit state before terminating. This is
   * best effort, not a guarantee: `postMessage` only queues the request on the
   * worker's event loop, so termination is deferred by one macrotask to give
   * the worker a chance to process it. Terminating in the same tick would
   * discard the message almost every time.
   *
   * Nothing is leaked when the dispose does not land — terminating a Worker
   * destroys its entire context, including the WASM heap that holds all of
   * artoolkit5-ts's state. The dispose is a courtesy to the library, not a
   * memory-management requirement.
   *
   * Also resets the in-flight frame flag (see `_onEngineUpdate`). Without
   * this, a frame left unacknowledged by the stopped worker would keep
   * `_onEngineUpdate` dropping every frame forever, even after a fresh
   * worker starts — a restarted worker must not be born blocked.
   *
   * Rejects every request still waiting on a reply (`loadMarker`,
   * `trackBarcode`, `configureDetector`), since the stopped worker can no
   * longer send one.
   *
   * @private
   */
  _stopWorker() {
    if (!this._worker) return;

    const worker = this._worker;
    this._worker = null;
    this._frameInFlight = false;
    // The next worker builds its own detector, possibly for another frame
    // size: until it sends camera, there is no projection to give out.
    this._projectionMatrix = null;

    try {
      worker.postMessage({ type: "dispose" });
    } catch {
      // Worker may already be gone; termination below is what matters.
    }

    worker.removeEventListener("message", this._onWorkerMessage);
    setTimeout(() => worker.terminate(), 0);

    // No reply can arrive any more: fail the callers now rather than at
    // their timeout. Their timers find the request gone and do nothing.
    for (const { reject } of this._pendingMarkerLoads.values()) {
      reject(new Error("Worker stopped before replying"));
    }
    this._pendingMarkerLoads.clear();
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
   * A marker not currently tracked emits `ar:markerFound`. One already
   * tracked emits `ar:markerUpdated` and has its `consecutiveMisses` counter
   * reset to 0 - a single good frame fully clears any misses accumulated by
   * {@link _applyMisses}, regardless of how close the marker was to crossing
   * `lostThreshold`. This is what keeps a marker's identity continuous
   * across a brief miss streak: as long as the registry entry survives, a
   * re-detection is treated as the same marker, never a new one.
   *
   * @param {Array<Object>} detected - Poses from the worker
   * @param {number} detected[].id - Marker ID within its family
   * @param {string} detected[].type - 'pattern' or 'barcode'
   * @param {number} detected[].confidence - Match confidence, 0-1
   * @param {Float32Array} detected[].matrixGL - 4x4 column-major pose
   * @param {Array<[number, number]>} [detected[].vertex] - The square's four
   *   corners in frame pixel coordinates. Optional on the way *in*: a detection
   *   that was not produced by this plugin's detector may omit it.
   * @param {number} [detected[].dir] - The marker's rotation, 0-3, which is what
   *   makes `vertex` order interpretable. Optional on the way in, as `vertex` is.
   *
   * On the way *out* both are **well-formed or absent, never malformed**: see
   * {@link usableVertex} and {@link usableDir}. Nothing is fabricated, so a
   * detection that arrives without them emits without them rather than with
   * invented values.
   * @returns {Set<string>} Registry keys of the markers seen this frame
   * @private
   */
  _applyDetections(detected) {
    const seen = new Set();
    if (!Array.isArray(detected)) return seen;

    for (const pose of detected) {
      const { id, type } = pose || {};
      if (id === null || id === undefined || !type) continue;

      const now = Date.now();
      const key = this._markerKey(id, type);
      seen.add(key);
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
        // Keys are always present, their values possibly undefined, so the
        // payload keeps one shape across every frame and matches the contract
        // table in AGENTS.md.
        vertex: usableVertex(pose.vertex),
        dir: usableDir(pose.dir),
        timestamp: now,
      };

      if (!prev) {
        this._markers.set(key, {
          lastSeen: now,
          visible: true,
          consecutiveMisses: 0,
          id,
          type,
        });
        this.core?.eventBus?.emit("ar:markerFound", payload);
      } else {
        prev.lastSeen = now;
        prev.visible = true;
        prev.consecutiveMisses = 0;
        this._markers.set(key, prev);
        this.core?.eventBus?.emit("ar:markerUpdated", payload);
      }
    }
    return seen;
  }

  /**
   * Debounce and apply `ar:markerLost` for tracked markers absent from the
   * frame just processed.
   *
   * ARToolKit routinely fails to detect a well-tracked marker on an isolated
   * frame - angle, motion blur, lighting - so a single miss must not be
   * treated as a loss. Every processed frame in which a tracked marker is
   * absent increments its `consecutiveMisses` counter; while that counter
   * stays below `lostThreshold` the marker stays in the registry and nothing
   * is emitted. Only once it reaches `lostThreshold` does `ar:markerLost`
   * fire, and the entry is removed at that point so a later detection
   * correctly emits `ar:markerFound` rather than `ar:markerUpdated`. Any
   * detection seen in the meantime resets the counter to 0 (see
   * {@link _applyDetections}), so reaching the threshold requires
   * `lostThreshold` *consecutive* missed frames, not a running total.
   *
   * The counter advances on absence from `detected`, not on the library's
   * `lost` list: artoolkit5-ts reports a loss exactly once, on the frame the
   * marker disappears, so counting `lost` entries never got past 1 (#38).
   * Absence also covers a detection dropped by confidence filtering, which the
   * library may not report as lost at all.
   *
   * @param {Set<string>} seen - Registry keys detected this frame
   * @private
   */
  _applyMisses(seen) {
    for (const [key, prev] of this._markers.entries()) {
      if (seen.has(key)) continue;

      prev.visible = false;
      prev.consecutiveMisses = (prev.consecutiveMisses || 0) + 1;
      if (prev.consecutiveMisses < this.lostThreshold) continue;

      this._markers.delete(key);
      this.core?.eventBus?.emit("ar:markerLost", {
        markerId: prev.id,
        type: prev.type,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle messages from the detection worker.
   *
   * Processes different message types and routes them appropriately:
   * - `ready`: Worker initialized, sets workerReady flag
   * - `detectionResult`: Clears the in-flight frame flag (see
   *   `_onEngineUpdate`) so the next frame may be sent, then applies
   *   detections and misses via _applyDetections/_applyMisses, unless the
   *   frame is `skipped` (nothing was analysed). The worker
   *   acknowledges every `processFrame` this way, including empty results,
   *   specifically so this flag can never get stuck.
   * - `loadMarkerResult`: Response to loadMarker request, resolves/rejects promise
   * - `camera`: The camera projection; stored for getProjectionMatrix() and
   *   emitted as ar:camera. Not a frame acknowledgement: the in-flight flag
   *   is left alone, since the frame still sends its own detectionResult.
   * - `error`: Worker error; also clears the in-flight frame flag, otherwise
   *   a failed frame would wedge frame submission permanently, then emits
   *   ar:workerError event
   *
   * @param {MessageEvent} ev - Message event from the worker
   * @param {Object} [ev.data] - Message data
   * @param {string} ev.data.type - Message type
   * @param {*} ev.data.payload - Message payload
   *
   * @private
   */
  _onWorkerMessage(ev) {
    const { type, payload } = ev.data || {};
    if (type === "ready") {
      console.log("[Plugin] Worker ready");
      this.workerReady = true;
      this.core?.eventBus?.emit("ar:workerReady", {});
    } else if (type === "camera") {
      // Not a frame acknowledgement: the frame that produced it still sends
      // its own detectionResult.
      const projectionMatrix = Float32Array.from(
        payload?.projectionMatrix ?? [],
      );
      if (projectionMatrix.length !== 16) return;
      this._projectionMatrix = projectionMatrix;
      this.core?.eventBus?.emit("ar:camera", {
        projectionMatrix: projectionMatrix.slice(),
        width: payload.width,
        height: payload.height,
        timestamp: Date.now(),
      });
    } else if (type === "detectionResult") {
      this._frameInFlight = false;
      // A frame acknowledged without being analysed (no ImageBitmap, or no
      // detector yet) says nothing about which markers are in view: it is not
      // a miss, and not a processed frame for the stall guard either.
      if (payload?.skipped) return;
      this._lastFrameAt = Date.now();
      if (!payload) return;
      this._applyMisses(this._applyDetections(payload.detected));
    } else if (
      type === "loadMarkerResult" ||
      type === "trackBarcodeResult" ||
      type === "configureResult"
    ) {
      const { requestId, ok, error, ...result } = payload || {};

      if (requestId !== undefined) {
        const pending = this._pendingMarkerLoads.get(requestId);
        if (pending) {
          this._pendingMarkerLoads.delete(requestId);
          if (ok) {
            pending.resolve(result);
          } else {
            pending.reject(new Error(error || `${type}: request failed`));
          }
        }
      }
    } else if (type === "initError") {
      // Reported while initialisation keeps retrying, so a missing WASM
      // binary is diagnosed at once (#40). Does not touch the in-flight flag:
      // the frame that triggered it is still acknowledged by its own
      // detectionResult.
      console.error("Artoolkit worker initialisation error", payload);
      this.core?.eventBus?.emit("ar:workerError", payload);
    } else if (type === "error") {
      console.error("Artoolkit worker error", payload);
      this._frameInFlight = false;
      this.core?.eventBus?.emit("ar:workerError", payload);
    }
  }

  /**
   * Stall guard: emit `ar:markerLost` for every tracked marker once frames
   * stop being processed.
   *
   * Loss is normally decided per processed frame (see {@link _applyMisses}).
   * That cannot see frames that stop arriving at all — a stalled camera, a
   * backgrounded tab, a dead worker — where a visible marker would otherwise
   * stay visible forever. So this measures the stall, not the marker: it acts
   * only when no frame has been acknowledged for
   * `lostThreshold * frameDurationMs`. A slow but live pipeline never trips
   * it, so at low frame rates loss still takes `lostThreshold` missed frames
   * (#38).
   *
   * @private
   */
  _sweepMarkers() {
    const now = Date.now();
    const stallMs = this.lostThreshold * this.frameDurationMs;
    if (now - this._lastFrameAt <= stallMs) return;

    for (const [key, state] of this._markers.entries()) {
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
   * @returns {Object|null} State with `lastSeen`, `visible`,
   *   `consecutiveMisses`, `id` and `type`, or null if the marker is not
   *   tracked (never seen, or already past `lostThreshold` misses).
   *   `consecutiveMisses` is the debounce count `_applyMisses` compares
   *   against `lostThreshold`; `visible` reflects only the most recently
   *   processed frame, true when detected, false during a miss streak that
   *   hasn't yet crossed the threshold - unlike `consecutiveMisses`, it does
   *   not say how long that streak has run.
   *
   * @example
   * const state = plugin.getMarkerState(42, 'pattern');
   * if (state && state.visible) console.log('last seen', state.lastSeen);
   */
  getMarkerState(markerId, type = "pattern") {
    return this._markers.get(this._markerKey(markerId, type)) || null;
  }

  /**
   * The camera projection matrix ARToolKit computed from the camera
   * parameters, as last published on `ar:camera`. It pairs with the marker
   * events' `matrix`: a renderer that missed the event reads it here.
   *
   * @returns {Float32Array|null} A fresh copy of the sixteen values, column-major,
   *   or null before the first frame has reached the detector
   */
  getProjectionMatrix() {
    return this._projectionMatrix ? this._projectionMatrix.slice() : null;
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

    return this._request("loadMarker", { patternUrl, size });
  }

  /**
   * Track a barcode (matrix code) marker.
   *
   * Barcodes need no file: the ID is encoded in the marker itself. If
   * `detectionMode` cannot detect barcodes it is switched to the closest mode
   * that can (`'color_and_matrix'`, or `'mono_and_matrix'` from `'mono'`) and
   * a warning is logged. Pattern and barcode IDs are independent, so barcode 0
   * and pattern 0 are different markers; events tell them apart by `type`.
   *
   * Can be called before frames flow: the barcode is registered when the
   * detector initialises on the first frame, and the promise settles then. If
   * no frame arrives within the request timeout (10 s) the call rejects, but
   * the barcode is still registered once a frame does.
   *
   * @param {number} barcodeId - ID encoded in the marker (for '3x3', 0-63)
   * @param {number} [size=1] - Marker width in world units
   * @returns {Promise<{markerId: number, size: number, detectionMode: string}>}
   *
   * @example
   * await plugin.trackBarcode(5, 1);
   * core.eventBus.on('ar:markerFound', (e) => {
   *   if (e.type === 'barcode' && e.markerId === 5) { ... }
   * });
   */
  async trackBarcode(barcodeId, size = 1) {
    if (!this._worker) {
      throw new Error(
        "Worker not available. Ensure plugin is enabled and worker is running.",
      );
    }
    return this._request("trackBarcode", { barcodeId, size });
  }

  /**
   * Change detector settings at runtime.
   *
   * Only the keys present are changed, and `minConfidence` only for the
   * families present. Keys are applied one at a time: when one is refused the
   * call rejects, but the others still take effect. Called before the first
   * frame, the promise settles once the detector initialises and applies it.
   * Accepts artoolkit5-ts `DetectorOptions`:
   * `detectionMode`, `matrixCodeType`, `threshold`, `thresholdMode`,
   * `labelingMode`, `imageProcMode`, `patternRatio`, `nearPlane`, `farPlane`
   * and `minConfidence` (a number, or `{ pattern, barcode }`).
   *
   * @param {Object} opts - Settings to change
   * @returns {Promise<{config: Object}>} The full configuration now in effect
   * @throws {Error} If an option is rejected by artoolkit5-ts
   *
   * @example
   * await plugin.configureDetector({ thresholdMode: 'auto_otsu' });
   */
  async configureDetector(opts = {}) {
    if (!this._worker) {
      throw new Error(
        "Worker not available. Ensure plugin is enabled and worker is running.",
      );
    }
    return this._request("configure", { opts });
  }

  /**
   * Post a request to the worker and wait for its `<type>Result` reply.
   *
   * @param {string} type - Worker message type
   * @param {Object} payload - Message payload; `requestId` is added here
   * @param {number} [timeoutMs=10000] - Reject if no reply arrives in time
   * @returns {Promise<Object>} The reply payload, minus `ok` and `requestId`
   * @private
   */
  _request(type, payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const requestId = this._nextLoadRequestId++;
      this._pendingMarkerLoads.set(requestId, { resolve, reject });

      try {
        this._worker.postMessage({
          type,
          payload: { ...payload, requestId },
        });
      } catch (err) {
        this._pendingMarkerLoads.delete(requestId);
        reject(new Error(`Failed to send ${type} message: ${err.message}`));
        return;
      }

      // Prevent hanging promises
      setTimeout(() => {
        if (this._pendingMarkerLoads.has(requestId)) {
          this._pendingMarkerLoads.delete(requestId);
          reject(new Error(`${type} request timed out`));
        }
      }, timeoutMs);
    });
  }
}

/**
 * @typedef {import("../types/plugin").ArtoolkitPluginOptions} ArtoolkitPluginOptions
 * @typedef {import("../types/plugin").EngineCore} EngineCore
 * @typedef {import("../types/plugin").EngineEventBus} EngineEventBus
 */
