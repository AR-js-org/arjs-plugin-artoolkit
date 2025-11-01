// src/plugin.js
/**
 * ArtoolkitPlugin
 * - maintains plugin lifecycle (init, enable, disable, dispose)
 * - optionally runs detection inside a Worker (src/worker/worker.js)
 * - subscribes to engine:update to send frames (ImageBitmap or frame metadata) to the worker
 * - emits ar:markerFound / ar:markerUpdated / ar:markerLost on the engine eventBus
 *
 * Works both in browsers (global Worker) and in Node (worker_threads.Worker).
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
            await this._startWorker();
        }

        // start a simple interval to sweep lost markers by time computed from frameDurationMs
        this._sweepInterval = setInterval(() => this._sweepMarkers(), this.sweepIntervalMs);
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

    // Engine frame handler: forward frame info or ImageBitmap to the worker
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

    // Worker lifecycle (cross-platform)
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
            this._worker.postMessage?.({ type: 'init' });
        } catch (e) {
            // ignore
        }
    }

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

    _onWorkerMessage(ev) {
        // worker_threads messages arrive as the raw payload; browser workers wrap in event.data
        const data = ev && ev.data !== undefined ? ev.data : ev;
        const { type, payload } = data || {};
        if (type === 'ready') {
            this.core?.eventBus?.emit('ar:workerReady', {});
        } else if (type === 'detectionResult') {
            if (!payload || !Array.isArray(payload.detections)) return;
            
            // Log detection results to main console
            if (payload.detections.length > 0) {
                console.log('[Plugin] Detection results:', payload.detections.map(d => 
                    `ID=${d.id}, confidence=${d.confidence?.toFixed(2)}`
                ).join(', '));
            }
            
            for (const d of payload.detections) {
                const id = d.id;
                const now = Date.now();
                const poseMatrix = new Float32Array(d.poseMatrix || []);
                const confidence = d.confidence ?? 0;
                const corners = d.corners ?? [];

                const prev = this._markers.get(id);
                if (!prev || !prev.visible) {
                    this._markers.set(id, { lastSeen: now, visible: true, lostCount: 0 });
                    console.log(`[Plugin] Marker found: ID=${id}, confidence=${confidence.toFixed(2)}`);
                    this.core.eventBus.emit('ar:markerFound', { id, poseMatrix, confidence, corners, timestamp: now });
                } else {
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
        const lostThresholdMs = this.lostThreshold * this.frameDurationMs;
        for (const [id, state] of this._markers.entries()) {
            const deltaMs = now - (state.lastSeen || 0);
            if (deltaMs > lostThresholdMs) {
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