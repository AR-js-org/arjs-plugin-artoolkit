// src/worker/worker.js
// Browser worker: integrates @ar-js-org/artoolkit5-js (ARToolKit) for simple marker detection.
// Node worker_threads: fallback stub behavior.
//
// Behavior:
// - On 'init' the worker will initialize the ARController via artoolkit5-js (if available).
// - On 'processFrame' with an ImageBitmap, it draws to an OffscreenCanvas and calls arController.process(canvas).
// - It then queries markers and posts detectionResult messages to main thread:
//   { detections: [ { id, confidence, poseMatrix: [...16], corners: [{x,y},...4] } ] }
// - If the toolchain fails to initialize, it falls back to the demo stub detection so pipeline remains testable.

let isNodeWorker = false;
let parent = null;

try {
    const wt = await import('node:worker_threads').catch(() => null);
    if (wt && wt.parentPort) {
        isNodeWorker = true;
        parent = wt.parentPort;
    }
} catch (e) {
    isNodeWorker = false;
    parent = null;
}

function onMessage(fn) {
    if (isNodeWorker) parent.on('message', (msg) => fn(msg));
    else self.addEventListener('message', (ev) => fn(ev.data));
}

function sendMessage(msg) {
    if (isNodeWorker) parent.postMessage(msg);
    else self.postMessage(msg);
}

// Worker state
let arController = null;        // ARController instance from artoolkit5-js
let arReady = false;
let debug = true;

let offscreenCanvas = null;
let offscreenCtx = null;
let canvasW = 0;
let canvasH = 0;

// Helper to try initialize the ARToolKit controller using the npm package
async function initArtoolkit(width = 640, height = 480, cameraParametersUrl = null) {
    try {
        // Import the library (this uses the package you installed)
        const jsartoolkit = await import('@ar-js-org/artoolkit5-js');
        const { ARController } = jsartoolkit;

        // Decide camera parameters url - follow AR.js-core default if nothing provided
        const camUrl = cameraParametersUrl || (jsartoolkit.ARController && jsartoolkit.ARController.baseUrl
            ? jsartoolkit.ARController.baseUrl + '../../data/data/camera_para.dat'
            : null);

        // ARController.initWithDimensions returns a Promise resolving to arController instance
        if (debug) console.log('[worker] initializing ARController with dimensions', width, height, 'cameraParams', camUrl);

        // Some builds accept ARController.initWithDimensions(width, height, cameraParamsUrl, opts)
        // We defensively call it and await the returned promise.
        arController = await ARController.initWithDimensions(width, height, camUrl || undefined, {});

        // Optionally expose debugging canvas if arController.debugSetup exists (not invoked here).
        arReady = !!arController;
        if (debug) console.log('[worker] ARController initialized', !!arController);
        return true;
    } catch (err) {
        arController = null;
        arReady = false;
        console.error('[worker] artoolkit init failed:', err && err.message ? err.message : err);
        return false;
    }
}

// Utility: convert artoolkit pose matrix (row-major or returned format) to a 16-number array
function normalizePoseMatrix(mat) {
    // If mat already array-like of length 16 return as Float32Array
    try {
        if (!mat) return null;
        if (Array.isArray(mat) && mat.length === 16) return Float32Array.from(mat);
        // Some artoolkit APIs return Float64Array or other; try to flatten
        if (mat.length === 16) return Float32Array.from(mat);
    } catch (e) {}
    return null;
}

// Utility to extract marker corners if available (some ARController builds expose marker corner coordinates)
function extractCorners(marker) {
    // marker may have .vertex or .corners or similar fields; be defensive
    try {
        if (!marker) return [];
        if (marker.x && marker.y) return [{ x: marker.x, y: marker.y }]; // unlikely
        if (marker.vertex && marker.vertex.length >= 4) {
            // vertex likely contains [x0,y0,x1,y1,...]
            const v = marker.vertex;
            const out = [];
            for (let i = 0; i < Math.min(4, v.length / 2); i++) {
                out.push({ x: v[i * 2], y: v[i * 2 + 1] });
            }
            return out;
        }
        if (marker.corners && marker.corners.length) {
            return marker.corners.map((c) => ({ x: c.x ?? c[0], y: c.y ?? c[1] }));
        }
    } catch (e) {}
    return [];
}

// Query arController for detected markers and map to the detection format expected by the plugin
function readDetectionsFromArController(frameId) {
    const detections = [];
    try {
        if (!arController) return detections;

        // Many ARController builds expose getMarkerNum() and getMarker(i) or marker_num and markers arrays.
        // Try several fallback paths.
        let num = 0;
        if (typeof arController.getMarkerNum === 'function') {
            num = arController.getMarkerNum();
        } else if (typeof arController.marker_num === 'number') {
            num = arController.marker_num;
        } else if (Array.isArray(arController.markers)) {
            num = arController.markers.length;
        }

        for (let i = 0; i < num; i++) {
            let marker = null;
            try {
                if (typeof arController.getMarker === 'function') {
                    marker = arController.getMarker(i);
                } else if (Array.isArray(arController.markers)) {
                    marker = arController.markers[i];
                }
            } catch (e) {
                marker = null;
            }
            if (!marker) continue;

            // ID: some APIs have marker.id or marker.patternId or marker.ppatternId
            const id = marker.id ?? marker.patternId ?? marker.pattern_id ?? String(i);

            // Confidence: many simple APIs don't return confidence. fallback to 1.0.
            const confidence = marker.cf ?? marker.confidence ?? 1.0;

            // Pose: try to get a transformation matrix. ARController sometimes exposes getTransMatSquare or getTransformMatrix
            let poseArr = null;
            try {
                if (typeof arController.getTransMatSquare === 'function') {
                    // This returns a 3x4 (12) or 4x4 matrix depending on build.
                    const m = arController.getTransMatSquare(i);
                    poseArr = normalizePoseMatrix(m);
                } else if (marker.transform && marker.transform.length === 16) {
                    poseArr = Float32Array.from(marker.transform);
                } else if (marker.trans && marker.trans.length === 16) {
                    poseArr = Float32Array.from(marker.trans);
                }
            } catch (e) {
                poseArr = null;
            }

            const corners = extractCorners(marker);

            detections.push({
                id,
                confidence,
                poseMatrix: poseArr ? Array.from(poseArr) : null,
                corners,
                frameId
            });
        }
    } catch (e) {
        console.warn('[worker] readDetectionsFromArController failed', e);
    }
    return detections;
}

onMessage(async (ev) => {
    const { type, payload } = ev || {};
    try {
        if (type === 'init') {
            // Initialize ARController in browser workers. We'll try to size to defaults; when the first frame arrives we can reinit if needed.
            if (!isNodeWorker) {
                const ok = await initArtoolkit(640, 480, null);
                if (!ok) {
                    // Will fall back to stub detection in processFrame
                    sendMessage({ type: 'error', payload: { message: 'ARToolKit initialization failed; falling back to stub detector' } });
                }
            } else {
                if (debug) console.log('[worker] running in Node worker mode (stub)');
            }
            sendMessage({ type: 'ready' });
        } else if (type === 'processFrame') {
            const { imageBitmap, frameId, width, height } = payload || {};

            if (!isNodeWorker && imageBitmap) {
                try {
                    // Initialize OffscreenCanvas if needed or if size changed
                    const w = width || imageBitmap.width || 640;
                    const h = height || imageBitmap.height || 480;
                    if (!offscreenCanvas || canvasW !== w || canvasH !== h) {
                        canvasW = w; canvasH = h;
                        offscreenCanvas = new OffscreenCanvas(canvasW, canvasH);
                        offscreenCtx = offscreenCanvas.getContext('2d');
                        // If ARController was initialized with different dims, consider reinit – simple approach: leave as-is.
                    }

                    offscreenCtx.clearRect(0, 0, canvasW, canvasH);
                    offscreenCtx.drawImage(imageBitmap, 0, 0, canvasW, canvasH);

                    // ImageBitmap was transferred, close it
                    try { imageBitmap.close?.(); } catch (e) {}

                    if (arReady && arController) {
                        // Call arController.process; many builds accept an HTMLCanvasElement or ImageData
                        try {
                            // Some ARController builds expect an <canvas> element object; OffscreenCanvas should be OK in workers.
                            arController.process(offscreenCanvas);
                        } catch (e) {
                            // Fallback: pass ImageData
                            try {
                                const imgData = offscreenCtx.getImageData(0, 0, canvasW, canvasH);
                                if (typeof arController.process === 'function') {
                                    arController.process(imgData);
                                }
                            } catch (errInner) {
                                console.warn('[worker] arController.process fallback failed', errInner);
                            }
                        }

                        // Read detections from arController
                        const detections = readDetectionsFromArController(frameId);
                        if (debug) console.log('[worker] detections', detections);
                        sendMessage({ type: 'detectionResult', payload: { detections } });
                    } else {
                        // Detector not ready -> fallback stub detection (keeps pipeline testable)
                        if (debug) console.log('[worker] detector not ready; emitting demo detection');
                        const fakeMatrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
                        const result = {
                            detections: [{
                                id: 'demo',
                                confidence: 0.9,
                                poseMatrix: Array.from(fakeMatrix),
                                corners: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
                                frameId
                            }]
                        };
                        sendMessage({ type: 'detectionResult', payload: result });
                    }
                } catch (err) {
                    console.error('[worker] processFrame error:', err);
                    sendMessage({ type: 'error', payload: { message: err?.message || String(err) } });
                }
            } else {
                // Node fallback behavior: keep the stub as before
                await new Promise((r) => setTimeout(r, 10));
                const fakeMatrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
                const result = {
                    detections: [{
                        id: 'demo',
                        confidence: 0.9,
                        poseMatrix: Array.from(fakeMatrix),
                        corners: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
                        frameId
                    }]
                };
                sendMessage({ type: 'detectionResult', payload: result });
            }
        }
    } catch (err) {
        sendMessage({ type: 'error', payload: { message: err?.message || String(err) } });
    }
});