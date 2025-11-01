// src/plugin.js
/**
 * ArtoolkitPlugin
 * - maintains plugin lifecycle (init, enable, disable, dispose)
 * - optionally runs detection inside a Worker (src/worker/worker.js)
 * - subscribes to engine:update to send frames (by id) to the worker
 * - emits ar:markerFound / ar:markerUpdated / ar:markerLost on the engine eventBus
 *
 * Note: the worker stub is intentionally simple and returns a fake detection.
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

        // configuration
        this.workerEnabled = options.worker !== false; // default true
        this.lostThreshold = options.lostThreshold ?? 5; // frames to consider lost
    }

    async init(core) {
        this.core = core;
        // Nothing heavy here; defer worker setup to enable()
        return this;
    }

    async enable() {
        if (!this.core) throw new Error('Plugin not initialized');
        if (this.enabled) return this;
        this.enabled = true;

        // subscribe to engine update to send frames to worker
        this.core.eventBus.on('engine:update', this._onEngineUpdate);

        // start worker if configured
        if (this.workerEnabled) {
            this._startWorker();
        }

        // start a simple interval to sweep lost markers by frame count (optional)
        this._sweepInterval = setInterval(() => this._sweepMarkers(), 100); // adjust as needed
        return this;
    }

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

    dispose() {
        return this.disable();
    }

    // Engine frame handler: forward frame info to the worker
    _onEngineUpdate(frame) {
        // frame is expected to be an object provided by the capture system, e.g.:
        // { id: number, timestamp, imageBitmap?, width, height, sourceRef }
        if (!frame) return;

        // Send lightweight message to worker (worker may accept ImageBitmap later)
        if (this._worker) {
            try {
                this._worker.postMessage({ type: 'processFrame', payload: { frameId: frame.id } });
            } catch (err) {
                // worker may be terminated; ignore
                console.warn('Artoolkit worker postMessage failed', err);
            }
        } else {
            // No worker: we could run detection inline in future
        }
    }

    // Worker lifecycle
    _startWorker() {
        if (this._worker) return;
        // spawn worker relative to this module
        this._worker = new Worker(new URL('./worker/worker.js', import.meta.url));
        this._worker.addEventListener('message', this._onWorkerMessage);
        this._worker.postMessage({ type: 'init' });
    }

    _stopWorker() {
        if (!this._worker) return;
        this._worker.removeEventListener('message', this._onWorkerMessage);
        try {
            this._worker.terminate();
        } catch (e) {
            // ignore
        }
        this._worker = null;
    }

    _onWorkerMessage(ev) {
        const { type, payload } = ev.data || {};
        if (type === 'ready') {
            // Worker initialized
            this.core?.eventBus?.emit('ar:workerReady', {});
        } else if (type === 'detectionResult') {
            // payload: { detections: [ { id, confidence, poseMatrix (array), corners, frameId } ] }
            if (!payload || !Array.isArray(payload.detections)) return;
            for (const d of payload.detections) {
                const id = d.id;
                const now = Date.now();
                const poseMatrix = new Float32Array(d.poseMatrix || []);
                const confidence = d.confidence ?? 0;
                const corners = d.corners ?? [];

                const prev = this._markers.get(id);
                if (!prev || !prev.visible) {
                    // newly found
                    this._markers.set(id, { lastSeen: now, visible: true, lostCount: 0 });
                    this.core.eventBus.emit('ar:markerFound', { id, poseMatrix, confidence, corners, timestamp: now });
                } else {
                    // updated
                    prev.lastSeen = now;
                    prev.lostCount = 0;
                    this._markers.set(id, prev);
                    this.core.eventBus.emit('ar:markerUpdated', { id, poseMatrix, confidence, corners, timestamp: now });
                }
            }
        } else if (type === 'error') {
            console.error('Artoolkit worker error', payload);
            this.core?.eventBus?.emit('ar:workerError', payload);
        }
    }

    // sweep markers and emit lost events for markers not seen recently
    _sweepMarkers() {
        const now = Date.now();
        for (const [id, state] of this._markers.entries()) {
            const deltaMs = now - (state.lastSeen || 0);
            // converted threshold: if not seen within lostThreshold * frameInterval (~100ms here) mark lost
            // simple heuristic: if lastSeen is older than lostThreshold * 200ms mark lost
            if (deltaMs > (this.lostThreshold * 200)) {
                // emit lost
                this._markers.delete(id);
                this.core.eventBus.emit('ar:markerLost', { id, timestamp: now });
            }
        }
    }

    // public helper to get marker state
    getMarkerState(markerId) {
        return this._markers.get(markerId) || null;
    }
}