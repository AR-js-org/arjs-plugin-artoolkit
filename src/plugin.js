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
 * @fires ar:getMarker - Raw AR.js-style marker detection events
 * 
 * @note Works in both browser (Web Worker) and Node.js (worker_threads) environments
 */
export class ArtoolkitPlugin {
    constructor(options = {}) {
        this.options = options;
        this.core = null;
        this.enabled = false;

        // Worker and handlers
        this._worker = null;
        this._onWorkerMessage = this._onWorkerMessage.bind(this);

        // Engine update subscription
        this._onEngineUpdate = this._onEngineUpdate.bind(this);

        // Marker state tracking: Map<id, { lastSeen: number, visible: boolean }>
        this._markers = new Map();

        // configuration (defaults)
        // lostThreshold: number of frames to consider a marker lost
        this.lostThreshold = options.lostThreshold ?? 5; // frames
        // frameDurationMs: how many milliseconds to consider a single 'frame' (used to convert lostThreshold -> ms)
        // Default 200ms per frame is a conservative default (5 fps). Consumers can adjust to match their capture rate.
        this.frameDurationMs = options.frameDurationMs ?? 200;
        // sweepIntervalMs: how often to run the lost-marker sweep (ms)
        this.sweepIntervalMs = options.sweepIntervalMs ?? 100;

        // Worker enabled toggle
        this.workerEnabled = options.worker !== false; // default true

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
        console.log(`[ArtoolkitPlugin] ${this.version} Initialized with core`, core);
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
        if (!this.core) throw new Error('Plugin not initialized');
        if (this.enabled) return this;
        this.enabled = true;

        // subscribe to engine update to send frames to worker
        this.core.eventBus.on('engine:update', this._onEngineUpdate);

        // start worker if configured
        if (this.workerEnabled) {
            await this._startWorker();
        }

        // start a simple interval to sweep lost markers by time computed from frameDurationMs
        this._sweepInterval = setInterval(() => this._sweepMarkers(), this.sweepIntervalMs);
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

        this.core.eventBus.off('engine:update', this._onEngineUpdate);

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
                if (typeof Worker !== 'undefined') {
                    // Browser: use transferable ImageBitmap
                    // The browser worker will receive event.data.payload.imageBitmap
                    this._worker.postMessage(
                        { type: 'processFrame', payload: { frameId: frame.id, imageBitmap: frame.imageBitmap, width: frame.width, height: frame.height } },
                        // transfer list: ImageBitmap is transferable
                        [frame.imageBitmap]
                    );
                    // After transfer, the main thread's ImageBitmap is neutered; consumer should not reuse it.
                } else {
                    // Node: ImageBitmap isn't available/transferable; fall back to sending metadata or ArrayBuffer if provided
                    this._worker.postMessage({ type: 'processFrame', payload: { frameId: frame.id, width: frame.width, height: frame.height } });
                }
            } catch (err) {
                console.warn('Artoolkit worker postMessage (ImageBitmap) failed, falling back to frameId only', err);
                try {
                    this._worker.postMessage({ type: 'processFrame', payload: { frameId: frame.id } });
                } catch (e) {
                    console.warn('worker postMessage failed', e);
                }
            }
            return;
        }

        // No ImageBitmap: send lighter payload as before (frameId)
        if (this._worker) {
            try {
                this._worker.postMessage({ type: 'processFrame', payload: { frameId: frame.id } });
            } catch (err) {
                console.warn('Artoolkit worker postMessage failed', err);
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
        if (typeof Worker !== 'undefined') {
            // Works in browsers and bundlers that support new URL(...) for workers
            this._worker = new Worker(new URL('./worker/worker.js', import.meta.url), { type: 'module' });
        } else {
            // Node environment: use worker_threads.Worker
            const { Worker: NodeWorker } = await import('node:worker_threads');
            const workerUrl = new URL('./worker/worker.js', import.meta.url);
            const { fileURLToPath } = await import('node:url');
            const workerPath = fileURLToPath(workerUrl);
            this._worker = new NodeWorker(workerPath, { type: 'module' });
        }

        // Attach message handler (same for both environments)
        if (this._worker.addEventListener) {
            this._worker.addEventListener('message', this._onWorkerMessage);
        } else if (this._worker.on) {
            this._worker.on('message', this._onWorkerMessage);
        }

        // If worker supports postMessage init, send init
        try {
            this._worker.postMessage?.({
                type: 'init',
                payload: {
                    moduleUrl: this.options.artoolkitModuleUrl || null,
                    cameraParametersUrl: this.options.cameraParametersUrl || null,
                    wasmBaseUrl: this.options.wasmBaseUrl || null
                }
            });
            // Watchdog: if 'ready' wasn’t received shortly, resend a no-op init once
            setTimeout(() => {
                if (!this.workerReady) {
                    try { this._worker?.postMessage?.({ type: 'init', payload: {} }); } catch {}
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
            this._worker.removeEventListener('message', this._onWorkerMessage);
        } else if (this._worker.off) {
            this._worker.off('message', this._onWorkerMessage);
        }

        try {
            if (typeof Worker !== 'undefined') {
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
     * Apply detection results and emit appropriate marker events.
     * 
     * Normalizes detection data and determines whether to emit markerFound or markerUpdated.
     * Updates internal marker tracking state (lastSeen, visible, lostCount).
     * 
     * **Event Logic:**
     * - First detection or previously invisible → emits `ar:markerFound`
     * - Already visible → emits `ar:markerUpdated`
     * 
     * @param {Array<Object>} detections - Array of detection results from worker
     * @param {number} detections[].id - Marker ID
     * @param {Array<number>} detections[].poseMatrix - 16-element pose matrix
     * @param {number} [detections[].confidence=0] - Detection confidence (0-1)
     * @param {Array<Array<number>>} [detections[].corners=[]] - Marker corner coordinates
     * 
     * @private
     */
    _applyDetections(detections) {
        if (!detections || !Array.isArray(detections)) return;
        for (const d of detections) {
            const id = d?.id;
            if (id === null || id === undefined) continue;

            const now = Date.now();
            const poseMatrix = new Float32Array(d.poseMatrix || []);
            const confidence = d.confidence ?? 0;
            const corners = d.corners ?? [];

            const prev = this._markers.get(id);
            if (!prev || !prev.visible) {
                this._markers.set(id, { lastSeen: now, visible: true, lostCount: 0 });
                this.core?.eventBus?.emit('ar:markerFound', { id, poseMatrix, confidence, corners, timestamp: now });
            } else {
                prev.lastSeen = now;
                prev.lostCount = 0;
                this._markers.set(id, prev);
                this.core?.eventBus?.emit('ar:markerUpdated', { id, poseMatrix, confidence, corners, timestamp: now });
            }
        }
    }

    /**
     * Handle messages from the detection worker.
     * 
     * Processes different message types and routes them appropriately:
     * - `ready`: Worker initialized, sets workerReady flag
     * - `detectionResult`: Normalized detection data, applies via _applyDetections
     * - `getMarker`: AR.js-style marker event, forwards to event bus and converts to detection
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
        if (type === 'ready') {
            console.log('[Plugin] Worker ready');
            this.workerReady = true;
            this.core?.eventBus?.emit('ar:workerReady', {});
        } else if (type === 'detectionResult') {
            console.log('[Plugin] Received detectionResult:', payload);
            // Normalize to marker events
            if (!payload || !Array.isArray(payload.detections)) return;
            this._applyDetections(payload.detections);
        } else if (type === 'getMarker') {
            // Forward AR.js-style getMarker payload (emitted by the worker) to the app/event bus
            try { console.log('[Plugin] getMarker', payload); } catch (_) {}
            this.core?.eventBus?.emit('ar:getMarker', payload);

            // ALSO translate this getMarker into a detection to drive markerFound/Updated
            try {
                const m = payload?.marker || {};
                const id = m.idPatt ?? m.patternId ?? m.pattern_id ?? null;

                // Matrix normalization
                let poseArray = null;
                if (Array.isArray(payload?.matrix)) {
                    poseArray = payload.matrix.slice(0, 16);
                } else if (payload?.matrix && typeof payload.matrix.length === 'number') {
                    poseArray = Array.from(payload.matrix).slice(0, 16);
                }

                // Corners/vertex normalization (optional)
                let corners = [];
                const v = m.vertex;
                if (Array.isArray(v)) {
                    // vertex may be [x0,y0,x1,y1,...]
                    for (let i = 0; i + 1 < v.length; i += 2) {
                        corners.push([v[i], v[i + 1]]);
                    }
                }

                const confidence = m.cfPatt ?? m.confidence ?? 0;

                if (id != null && poseArray && poseArray.length === 16) {
                    this._applyDetections([{
                        id,
                        confidence,
                        poseMatrix: poseArray,
                        corners
                    }]);
                }
            } catch (e) {
                // ignore conversion errors; raw getMarker still forwarded
            }
        } else if (type === 'loadMarkerResult') {
            console.log('[Plugin] Received loadMarkerResult:', payload);
            const { requestId, ok, error, markerId, size } = payload || {};

            if (requestId !== undefined) {
                const pending = this._pendingMarkerLoads.get(requestId);
                if (pending) {
                    this._pendingMarkerLoads.delete(requestId);
                    if (ok) {
                        pending.resolve({ markerId, size });
                    } else {
                        pending.reject(new Error(error || 'Failed to load marker'));
                    }
                }
            }
        } else if (type === 'error') {
            console.error('Artoolkit worker error', payload);
            this.core?.eventBus?.emit('ar:workerError', payload);
        }
    }

    /**
     * Internal sweep to detect and emit lost markers.
     * 
     * Checks all tracked markers against the lost threshold.
     * Markers not seen recently are removed and ar:markerLost is emitted.
     * 
     * @private
     */
    _sweepMarkers() {
        const now = Date.now();
        const lostThresholdMs = this.lostThreshold * this.frameDurationMs;
        for (const [id, state] of this._markers.entries()) {
            const deltaMs = now - (state.lastSeen || 0);
            if (deltaMs > lostThresholdMs) {
                this._markers.delete(id);
                this.core.eventBus.emit('ar:markerLost', { id, timestamp: now });
            }
        }
    }

    /**
     * Get the current tracking state of a marker.
     * 
     * @param {number} markerId - Marker ID to query
     * @returns {Object|null} Marker state object with lastSeen, visible, lostCount, or null if not tracked
     * 
     * @example
     * const state = plugin.getMarkerState(42);
     * if (state && state.visible) {
     *   console.log('Marker 42 last seen:', state.lastSeen);
     * }
     */
    getMarkerState(markerId) {
        return this._markers.get(markerId) || null;
    }

    /**
     * Load a pattern marker from a URL
     * @param {string} patternUrl - URL to the pattern file (absolute or repo-relative)
     * @param {number} size - Size of the marker in world units (default: 1)
     * @returns {Promise<{markerId: number, size: number}>} - Resolves with marker info when loaded
     */
    async loadMarker(patternUrl, size = 1) {
        if (!this._worker) {
            throw new Error('Worker not available. Ensure plugin is enabled and worker is running.');
        }

        console.log(`[Plugin] Loading marker: ${patternUrl} with size ${size}`);

        return new Promise((resolve, reject) => {
            const requestId = this._nextLoadRequestId++;
            this._pendingMarkerLoads.set(requestId, { resolve, reject });

            // Send loadMarker message to worker
            try {
                this._worker.postMessage({
                    type: 'loadMarker',
                    payload: { patternUrl, size, requestId }
                });
            } catch (err) {
                this._pendingMarkerLoads.delete(requestId);
                reject(new Error(`Failed to send loadMarker message: ${err.message}`));
            }

            // Set a timeout to prevent hanging promises
            setTimeout(() => {
                if (this._pendingMarkerLoads.has(requestId)) {
                    this._pendingMarkerLoads.delete(requestId);
                    reject(new Error('loadMarker request timed out'));
                }
            }, 10000); // 10 second timeout
        });
    }
}