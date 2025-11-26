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
    constructor(options?: {});
    /** @type {ArtoolkitPluginOptions} */
    options: ArtoolkitPluginOptions;
    /** @type {EngineCore | null} */
    core: EngineCore | null;
    /** @type {boolean} */
    enabled: boolean;
    _worker: any;
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
    private _onWorkerMessage;
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
    private _onEngineUpdate;
    _markers: Map<any, any>;
    lostThreshold: any;
    frameDurationMs: any;
    sweepIntervalMs: any;
    workerEnabled: any;
    _pendingMarkerLoads: Map<any, any>;
    _nextLoadRequestId: number;
    workerReady: boolean;
    version: string;
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
    init(core: {
        eventBus: any;
    }): Promise<ArtoolkitPlugin>;
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
    enable(): Promise<ArtoolkitPlugin>;
    _sweepInterval: number;
    /**
     * Disable the plugin and stop marker detection.
     *
     * - Unsubscribes from engine:update events
     * - Stops and terminates the detection worker
     * - Clears the marker sweep interval
     *
     * @returns {Promise<ArtoolkitPlugin>} This plugin instance
     */
    disable(): Promise<ArtoolkitPlugin>;
    /**
     * Dispose of the plugin and clean up resources.
     *
     * Alias for disable() - stops detection and terminates worker.
     *
     * @returns {Promise<ArtoolkitPlugin>} This plugin instance
     */
    dispose(): Promise<ArtoolkitPlugin>;
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
    private _startWorker;
    /**
     * Stop and terminate the detection worker.
     *
     * Removes message event handlers and terminates the worker thread.
     * Works for both browser Workers and Node.js worker_threads.
     *
     * @private
     */
    private _stopWorker;
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
    private _applyDetections;
    /**
     * Internal sweep to detect and emit lost markers.
     *
     * Checks all tracked markers against the lost threshold.
     * Markers not seen recently are removed and ar:markerLost is emitted.
     *
     * @private
     */
    private _sweepMarkers;
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
    getMarkerState(markerId: number): any | null;
    /**
     * Load a pattern marker from a URL
     * @param {string} patternUrl - URL to the pattern file (absolute or repo-relative)
     * @param {number} size - Size of the marker in world units (default: 1)
     * @returns {Promise<{markerId: number, size: number}>} - Resolves with marker info when loaded
     */
    loadMarker(patternUrl: string, size?: number): Promise<{
        markerId: number;
        size: number;
    }>;
}
export type ArtoolkitPluginOptions = any;
export type EngineCore = any;
export type EngineEventBus = any;
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
export const ARTOOLKIT_PLUGIN_VERSION: string;
//# sourceMappingURL=plugin.d.ts.map