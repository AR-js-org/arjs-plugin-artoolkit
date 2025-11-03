// Cross-platform worker integrating ARToolKit in browser Workers.
// - Browser: processes ImageBitmap → OffscreenCanvas → ARToolKit.process(canvas)
// - Node: keeps stub behavior if needed
let isNodeWorker = false;
let parent = null;

let arController = null;
let arControllerInitialized = false;
let getMarkerForwarderAttached = false;

let offscreenCanvas = null;
let offscreenCtx = null;
let canvasW = 0;
let canvasH = 0;

// Marker and filtering state
const loadedMarkers = new Map();    // patternUrl -> markerId
const loadingMarkers = new Map();   // patternUrl -> Promise<markerId>
const trackedPatternIds = new Set(); // Set<number>
let PATTERN_MARKER_TYPE = 0;        // will be read from ARToolkit if available
let MIN_CONFIDENCE = 0.6;           // configurable via init payload

// Init backoff state
let initInProgress = null;
let initFailCount = 0;
let initFailedUntil = 0;

// Init-time options (overridable from main thread)
let INIT_OPTS = {
    moduleUrl: null,
    cameraParametersUrl: null,
    wasmBaseUrl: null,
    minConfidence: null
};

if (typeof self === 'undefined') {
    try {
        const wt = await import('node:worker_threads').catch(() => null);
        if (wt && wt.parentPort) {
            isNodeWorker = true;
            parent = wt.parentPort;
        }
    } catch {
        isNodeWorker = false;
        parent = null;
    }
}

function onMessage(fn) {
    if (isNodeWorker) parent.on('message', (msg) => fn(msg));
    else self.addEventListener('message', (ev) => fn(ev.data));
}

function sendMessage(msg) {
    if (isNodeWorker) parent.postMessage(msg);
    else self.postMessage(msg);
}

// Serialize AR.js-style getMarker event into a transferable payload
function serializeGetMarkerEvent(ev) {
    try {
        const data = ev?.data || {};
        const marker = data.marker || {};
        const matrix = Array.isArray(data.matrix) ? data.matrix.slice(0, 16)
            : (data.matrix && data.matrix.length ? Array.from(data.matrix).slice(0, 16) : null);
        const vertex = marker.vertex
            ? (Array.isArray(marker.vertex) ? marker.vertex.slice() : null)
            : (marker.corners ? marker.corners.flatMap(c => [c.x ?? c[0], c.y ?? c[1]]) : null);

        return {
            type: data.type, // e.g., ARToolkit.PATTERN_MARKER
            matrix,
            marker: {
                idPatt: marker.idPatt ?? marker.patternId ?? marker.pattern_id ?? null,
                idMatrix: marker.idMatrix ?? null,
                cfPatt: marker.cfPatt ?? marker.confidence ?? null,
                cfMatrix: marker.cfMatrix ?? null,
                vertex: vertex || null
            }
        };
    } catch {
        return { type: null, matrix: null, marker: {} };
    }
}

function shouldForwardGetMarker(event) {
    const data = event?.data || {};
    const type = data.type;
    const marker = data.marker || {};
    const id = marker.idPatt ?? marker.patternId ?? marker.pattern_id ?? null;
    const conf = marker.cfPatt ?? marker.confidence ?? 0;
    const matrix = data.matrix;

    // Type must be PATTERN_MARKER (fallback numeric 0 if constants not available)
    if (type !== PATTERN_MARKER_TYPE) return false;

    // Confidence gate
    if (!(Number.isFinite(conf) && conf >= MIN_CONFIDENCE)) return false;

    // Matrix must exist with at least 16 values
    const m = Array.isArray(matrix) ? matrix : (matrix && Array.from(matrix)) || null;
    if (!m || m.length < 16) return false;

    // If we have tracked IDs, only forward those IDs
    if (trackedPatternIds.size && id != null && !trackedPatternIds.has(id)) return false;

    return true;
}

function attachGetMarkerForwarder() {
    if (!arController || typeof arController.addEventListener !== 'function' || getMarkerForwarderAttached) return;
    arController.addEventListener('getMarker', (event) => {
        if (!shouldForwardGetMarker(event)) return;
        const payload = serializeGetMarkerEvent(event);
        try { console.log('[Worker] getMarker (filtered)', payload); } catch {}
        sendMessage({ type: 'getMarker', payload });
    });
    getMarkerForwarderAttached = true;
}

// Guarded init with backoff
async function initArtoolkit(width = 640, height = 480) {
    if (arControllerInitialized) return true;

    const now = Date.now();
    if (now < initFailedUntil) {
        const waitMs = initFailedUntil - now;
        console.warn('[Worker] initArtoolkit skipped due to backoff (ms):', waitMs);
        return false;
    }

    if (initInProgress) {
        try {
            await initInProgress;
            return arControllerInitialized;
        } catch {
            return false;
        }
    }

    initInProgress = (async () => {
        try {
            const jsartoolkit = await (async () => {
                if (INIT_OPTS.moduleUrl) {
                    console.log('[Worker] Loading artoolkit from moduleUrl:', INIT_OPTS.moduleUrl);
                    return await import(INIT_OPTS.moduleUrl);
                }
                // If your environment supports bare import (import map/bundler), this will work:
                return await import('@ar-js-org/artoolkit5-js');
            })();

            //const { ARController, ARToolkit } = jsartoolkit;

            // Read the constant if available; else keep default 0
            if (ARToolkit && typeof ARToolkit.PATTERN_MARKER === 'number') {
                PATTERN_MARKER_TYPE = ARToolkit.PATTERN_MARKER;
            }

            if (INIT_OPTS.wasmBaseUrl && ARController) {
                try {
                    ARController.baseURL = INIT_OPTS.wasmBaseUrl.endsWith('/') ? INIT_OPTS.wasmBaseUrl : INIT_OPTS.wasmBaseUrl + '/';
                } catch {}
            }

            if (typeof INIT_OPTS.minConfidence === 'number') {
                MIN_CONFIDENCE = INIT_OPTS.minConfidence;
            }

            const camUrl = INIT_OPTS.cameraParametersUrl
                || 'https://raw.githack.com/AR-js-org/AR.js/master/data/data/camera_para.dat';

            console.log('[Worker] ARToolKit init', { width, height, camUrl, minConfidence: MIN_CONFIDENCE, patternType: PATTERN_MARKER_TYPE });
            arController = await ARToolkit.ARController.initWithDimensions(width, height, camUrl, {});
            arControllerInitialized = !!arController;
            console.log('[Worker] ARToolKit initialized:', arControllerInitialized);

            if (!arControllerInitialized) throw new Error('ARController.initWithDimensions returned falsy controller');

            attachGetMarkerForwarder();

            initFailCount = 0;
            initFailedUntil = 0;
        } catch (err) {
            console.error('[Worker] ARToolKit init failed:', err);
            arController = null;
            arControllerInitialized = false;

            initFailCount = Math.min(initFailCount + 1, 6);
            const delay = Math.min(30000, 1000 * Math.pow(2, initFailCount));
            initFailedUntil = Date.now() + delay;

            sendMessage({ type: 'error', payload: { message: `ARToolKit init failed (${err?.message || err}). Retrying in ${delay}ms.` } });
            throw err;
        } finally {
            initInProgress = null;
            return arControllerInitialized;
        }
    })();

    try {
        await initInProgress;
    } catch {}
    return arControllerInitialized;
}

// Dedupe marker loading by URL and record tracked IDs
async function loadPatternOnce(patternUrl) {
    if (loadedMarkers.has(patternUrl)) return loadedMarkers.get(patternUrl);
    if (loadingMarkers.has(patternUrl)) return loadingMarkers.get(patternUrl);

    const p = (async () => {
        const id = await arController.loadMarker(patternUrl);
        loadedMarkers.set(patternUrl, id);
        trackedPatternIds.add(id);
        loadingMarkers.delete(patternUrl);
        return id;
    })().catch((e) => {
        loadingMarkers.delete(patternUrl);
        throw e;
    });

    loadingMarkers.set(patternUrl, p);
    return p;
}

onMessage(async (ev) => {
    const { type, payload } = ev || {};
    try {
        if (type === 'init') {
            if (payload && typeof payload === 'object') {
                INIT_OPTS.moduleUrl = payload.moduleUrl ?? INIT_OPTS.moduleUrl;
                INIT_OPTS.cameraParametersUrl = payload.cameraParametersUrl ?? INIT_OPTS.cameraParametersUrl;
                INIT_OPTS.wasmBaseUrl = payload.wasmBaseUrl ?? INIT_OPTS.wasmBaseUrl;
                if (typeof payload.minConfidence === 'number') {
                    INIT_OPTS.minConfidence = payload.minConfidence;
                    MIN_CONFIDENCE = payload.minConfidence;
                }
            }
            sendMessage({ type: 'ready' });
            return;
        }

        if (type === 'loadMarker') {
            const { patternUrl, size = 1, requestId } = payload || {};
            if (!patternUrl) {
                sendMessage({ type: 'loadMarkerResult', payload: { ok: false, error: 'Missing patternUrl parameter', requestId } });
                return;
            }
            try {
                const ok = await initArtoolkit(640, 480);
                if (!ok) throw new Error('ARToolKit not initialized');

                const markerId = await loadPatternOnce(patternUrl);
                if (typeof arController.trackPatternMarkerId === 'function') {
                    arController.trackPatternMarkerId(markerId, size);
                } else if (typeof arController.trackPatternMarker === 'function') {
                    arController.trackPatternMarker(markerId, size);
                }
                sendMessage({ type: 'loadMarkerResult', payload: { ok: true, markerId, size, requestId } });
            } catch (err) {
                console.error('[Worker] loadMarker error:', err);
                sendMessage({ type: 'loadMarkerResult', payload: { ok: false, error: err?.message || String(err), requestId } });
            }
            return;
        }

        if (type === 'processFrame') {
            const { imageBitmap, width, height } = payload || {};
            if (!isNodeWorker && imageBitmap) {
                try {
                    const w = width || imageBitmap.width || 640;
                    const h = height || imageBitmap.height || 480;

                    await initArtoolkit(w, h);

                    if (!offscreenCanvas || canvasW !== w || canvasH !== h) {
                        canvasW = w; canvasH = h;
                        offscreenCanvas = new OffscreenCanvas(canvasW, canvasH);
                        offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: false });
                    }

                    offscreenCtx.clearRect(0, 0, canvasW, canvasH);
                    offscreenCtx.drawImage(imageBitmap, 0, 0, canvasW, canvasH);
                    try { imageBitmap.close?.(); } catch {}

                    if (arControllerInitialized && arController) {
                        try {
                            arController.process(offscreenCanvas);
                        } catch (e) {
                            try {
                                const imgData = offscreenCtx.getImageData(0, 0, canvasW, canvasH);
                                arController.process(imgData);
                            } catch (inner) {
                                console.warn('[Worker] ARToolKit process fallback failed:', inner);
                            }
                        }
                    }
                } catch (err) {
                    console.error('[Worker] processFrame error:', err);
                }
                return;
            }

            await new Promise((r) => setTimeout(r, 5));
            return;
        }
    } catch (err) {
        sendMessage({ type: 'error', payload: { message: err?.message || String(err) } });
    }
});