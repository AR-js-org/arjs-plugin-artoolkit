// Cross-platform worker integrating ARToolKit in browser Workers.
// - Browser: processes ImageBitmap → OffscreenCanvas → ARToolKit.process(canvas)
// - Node: keeps stub behavior
let isNodeWorker = false;
let parent = null;

let arController = null;
let arControllerInitialized = false;
let getMarkerForwarderAttached = false;

let offscreenCanvas = null;
let offscreenCtx = null;
let canvasW = 0;
let canvasH = 0;

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

// AR.js-style getMarker event serializer
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

async function initArtoolkit(width = 640, height = 480, cameraParametersUrl) {
    if (arControllerInitialized) return true;
    try {
        // Lazy import to keep worker module-light

        const cdn = 'https://cdn.jsdelivr.net/npm/@ar-js-org/artoolkit5-js@0.3.2/dist/ARToolkit.min.js';
        console.log('[Worker] Trying CDN import:', cdn);
        // const jsartoolkit = await import(cdn);
        await import(cdn);
        // const { ARController } = jsartoolkit;
        // console.log(ARToolkit)

        const camUrl = cameraParametersUrl
            || 'https://raw.githack.com/AR-js-org/AR.js/master/data/data/camera_para.dat';

        console.log('[Worker] ARToolKit init', { width, height, camUrl });
        arController = await ARToolkit.ARController.initWithDimensions(width, height, camUrl, {});
        arControllerInitialized = !!arController;
        console.log('[Worker] ARToolKit initialized:', arControllerInitialized);

        attachGetMarkerForwarder();
        return true;
    } catch (err) {
        console.error('[Worker] ARToolKit init failed:', err);
        arController = null;
        arControllerInitialized = false;
        return false;
    }
}

onMessage(async (ev) => {
    const { type, payload } = ev || {};
    try {
        if (type === 'init') {
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
                if (!arControllerInitialized) {
                    // Initialize with some defaults; will be resized on first frame as needed
                    const ok = await initArtoolkit(640, 480);
                    if (!ok) throw new Error('Failed to initialize ARToolKit');
                }
                const markerId = await arController.loadMarker(patternUrl);
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
            // In browser: drive ARToolKit processing so it emits getMarker (with the real matrix)
            if (!isNodeWorker && imageBitmap) {
                try {
                    const w = width || imageBitmap.width || 640;
                    const h = height || imageBitmap.height || 480;

                    // Initialize ARToolKit with actual frame size (first time)
                    if (!arControllerInitialized) {
                        await initArtoolkit(w, h);
                    }

                    // Prepare OffscreenCanvas
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
                            // Prefer passing canvas to ARToolKit so it can compute matrix and emit getMarker
                            arController.process(offscreenCanvas);
                        } catch (e) {
                            // Fallback: pass ImageData if this build requires it
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
                    sendMessage({ type: 'error', payload: { message: err?.message || String(err) } });
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