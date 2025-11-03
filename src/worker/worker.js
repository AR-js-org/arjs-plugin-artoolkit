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

// Init backoff state
let initInProgress = null;         // Promise | null
let initFailCount = 0;             // increases on each failure
let initFailedUntil = 0;           // timestamp when next retry is allowed

// Marker cache/dedupe
const loadedMarkers = new Map();   // patternUrl -> markerId
const loadingMarkers = new Map();  // patternUrl -> Promise<markerId>

// Init-time options (can be overridden via init payload if you already set this up)
let INIT_OPTS = {
    moduleUrl: null,
    cameraParametersUrl: null,
    wasmBaseUrl: null
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

function attachGetMarkerForwarder() {
    if (!arController || typeof arController.addEventListener !== 'function' || getMarkerForwarderAttached) return;
    arController.addEventListener('getMarker', (event) => {
        const payload = serializeGetMarkerEvent(event);
        try { console.log('[Worker] getMarker', payload); } catch {}
        sendMessage({ type: 'getMarker', payload });
    });
    getMarkerForwarderAttached = true;
}

// IMPORTANT: this function should be the only place that initializes ARToolKit.
// It is guarded by initInProgress and a failure backoff.
async function initArtoolkit(width = 640, height = 480) {
    if (arControllerInitialized) return true;

    // Respect backoff window
    const now = Date.now();
    if (now < initFailedUntil) {
        const waitMs = initFailedUntil - now;
        console.warn('[Worker] initArtoolkit skipped due to backoff (ms):', waitMs);
        return false;
    }

    // If an init is already in-flight, await it
    if (initInProgress) {
        try {
            await initInProgress;
            return arControllerInitialized;
        } catch {
            return false;
        }
    }

    // Start a new init attempt
    initInProgress = (async () => {
        try {
            const jsartoolkit = await (async () => {
                if (INIT_OPTS.moduleUrl) {
                    console.log('[Worker] Loading artoolkit from moduleUrl:', INIT_OPTS.moduleUrl);
                    return await import(INIT_OPTS.moduleUrl);
                }
                // Fallback to bare import if your environment supports it (import map/bundler)
                return await import('@ar-js-org/artoolkit5-js');
            })();

            const { ARController } = jsartoolkit;

            if (INIT_OPTS.wasmBaseUrl && ARController) {
                try {
                    ARController.baseURL = INIT_OPTS.wasmBaseUrl.endsWith('/') ? INIT_OPTS.wasmBaseUrl : INIT_OPTS.wasmBaseUrl + '/';
                } catch {}
            }

            const camUrl = INIT_OPTS.cameraParametersUrl
                || 'https://raw.githack.com/AR-js-org/AR.js/master/data/data/camera_para.dat';

            console.log('[Worker] ARToolKit init', { width, height, camUrl });
            arController = await ARToolkit.ARController.initWithDimensions(width, height, camUrl, {});
            arControllerInitialized = !!arController;
            console.log('[Worker] ARToolKit initialized:', arControllerInitialized);

            if (!arControllerInitialized) throw new Error('ARController.initWithDimensions returned falsy controller');

            attachGetMarkerForwarder();

            // Reset failure state
            initFailCount = 0;
            initFailedUntil = 0;
        } catch (err) {
            console.error('[Worker] ARToolKit init failed:', err);
            arController = null;
            arControllerInitialized = false;

            // Exponential backoff up to 30s
            initFailCount = Math.min(initFailCount + 1, 6); // caps at ~64x
            const delay = Math.min(30000, 1000 * Math.pow(2, initFailCount)); // 1s,2s,4s,8s,16s,30s
            initFailedUntil = Date.now() + delay;

            // Surface a single error to main thread (optional)
            sendMessage({ type: 'error', payload: { message: `ARToolKit init failed (${err?.message || err}). Retrying in ${delay}ms.` } });
            throw err;
        } finally {
            // Mark as done (success or failure)
            const ok = arControllerInitialized;
            initInProgress = null;
            return ok;
        }
    })();

    try {
        await initInProgress;
    } catch {
        // already handled
    }
    return arControllerInitialized;
}

// Dedupe marker loading by URL
async function loadPatternOnce(patternUrl) {
    if (loadedMarkers.has(patternUrl)) return loadedMarkers.get(patternUrl);
    if (loadingMarkers.has(patternUrl)) return loadingMarkers.get(patternUrl);

    const p = (async () => {
        const id = await arController.loadMarker(patternUrl);
        loadedMarkers.set(patternUrl, id);
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
            // Accept init overrides
            if (payload && typeof payload === 'object') {
                INIT_OPTS.moduleUrl = payload.moduleUrl || INIT_OPTS.moduleUrl;
                INIT_OPTS.cameraParametersUrl = payload.cameraParametersUrl || INIT_OPTS.cameraParametersUrl;
                INIT_OPTS.wasmBaseUrl = payload.wasmBaseUrl || INIT_OPTS.wasmBaseUrl;
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

            // Browser path: only attempt init at controlled cadence (guard handles backoff)
            if (!isNodeWorker && imageBitmap) {
                try {
                    const w = width || imageBitmap.width || 640;
                    const h = height || imageBitmap.height || 480;

                    // Attempt init once; if it fails, guard prevents hammering it per-frame
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
                    // No spam: let initArtoolkit handle error posting and backoff logging
                }
                return;
            }

            // Node fallback: do nothing (no real AR in Node)
            await new Promise((r) => setTimeout(r, 5));
            return;
        }
    } catch (err) {
        sendMessage({ type: 'error', payload: { message: err?.message || String(err) } });
    }
});