// Cross-platform worker stub (browser Worker and Node worker_threads)
// Accepts ImageBitmap in browser and cleans it up after use.
// In Node, it accepts the lightweight frame messages (frameId).
let isNodeWorker = false;
let parent = null;

// ARController stub - in a real implementation, this would be the actual ARToolKit controller
let arController = null;
let arControllerInitialized = false;

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
    if (isNodeWorker) {
        parent.on('message', (msg) => fn(msg));
    } else {
        self.addEventListener('message', (ev) => fn(ev.data));
    }
}

function sendMessage(msg) {
    if (isNodeWorker) {
        parent.postMessage(msg);
    } else {
        self.postMessage(msg);
    }
}

// Initialize ARController with default dimensions if not already initialized
async function initArtoolkit(width = 640, height = 480) {
    if (arControllerInitialized) {
        return true;
    }
    
    try {
        // Stub implementation - in real usage, this would initialize the actual ARToolKit WASM module
        console.log(`[Worker] Initializing ARToolKit with dimensions ${width}x${height}`);
        
        // Simulate ARController initialization
        arController = {
            loadMarker: async (patternUrl) => {
                console.log(`[Worker] Loading marker pattern from: ${patternUrl}`);
                // Simulate async marker loading
                await new Promise((r) => setTimeout(r, 50));
                // Return a simulated marker ID
                return Math.floor(Math.random() * 1000);
            },
            trackPatternMarkerId: (markerId, size) => {
                console.log(`[Worker] Tracking pattern marker ID ${markerId} with size ${size}`);
                return true;
            }
        };
        
        arControllerInitialized = true;
        console.log('[Worker] ARToolKit initialized successfully');
        return true;
    } catch (err) {
        console.error('[Worker] Failed to initialize ARToolKit:', err);
        arControllerInitialized = false;
        return false;
    }
}

onMessage(async (ev) => {
    const { type, payload } = ev || {};
    try {
        if (type === 'init') {
            sendMessage({ type: 'ready' });
        } else if (type === 'loadMarker') {
            // Handle marker loading request
            console.log('[Worker] Received loadMarker message:', payload);
            const { patternUrl, size, requestId } = payload || {};
            
            if (!patternUrl) {
                console.error('[Worker] loadMarker: missing patternUrl');
                sendMessage({ 
                    type: 'loadMarkerResult', 
                    payload: { ok: false, error: 'Missing patternUrl parameter', requestId } 
                });
                return;
            }
            
            try {
                // Ensure ARController is initialized before loading marker
                if (!arControllerInitialized) {
                    console.log('[Worker] Initializing ARToolKit with default dimensions before loading marker');
                    const initSuccess = await initArtoolkit();
                    if (!initSuccess) {
                        throw new Error('Failed to initialize ARToolKit');
                    }
                }
                
                // Load the marker pattern
                console.log(`[Worker] Loading marker from ${patternUrl}`);
                const markerId = await arController.loadMarker(patternUrl);
                console.log(`[Worker] Marker loaded with ID: ${markerId}`);
                
                // Track the pattern marker with specified size (default to 1)
                const markerSize = size !== undefined ? size : 1;
                console.log(`[Worker] Tracking pattern marker ${markerId} with size ${markerSize}`);
                arController.trackPatternMarkerId(markerId, markerSize);
                
                sendMessage({ 
                    type: 'loadMarkerResult', 
                    payload: { ok: true, markerId, size: markerSize, requestId } 
                });
                console.log('[Worker] Marker loading completed successfully');
            } catch (err) {
                console.error('[Worker] Error loading marker:', err);
                sendMessage({ 
                    type: 'loadMarkerResult', 
                    payload: { ok: false, error: err?.message || String(err), requestId } 
                });
            }
        } else if (type === 'processFrame') {
            // Browser: payload.imageBitmap may exist
            const { imageBitmap, frameId } = payload || {};

            // If ImageBitmap present, we could run detection on it.
            // In this stub, we just simulate a small delay, then close the ImageBitmap.
            if (imageBitmap && typeof imageBitmap.close === 'function') {
                // simulate async processing
                await new Promise((r) => setTimeout(r, 10));
                // optional: read pixels via OffscreenCanvas if needed
                try {
                    // Always close the ImageBitmap to free resources
                    imageBitmap.close();
                } catch (e) {
                    // ignore
                }
            } else {
                // No ImageBitmap (Node mode or fallback). Simulate async detection.
                await new Promise((r) => setTimeout(r, 10));
            }

            const fakeMatrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
            const result = {
                detections: [
                    {
                        id: 'demo',
                        confidence: 0.9,
                        poseMatrix: Array.from(fakeMatrix),
                        corners: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
                        frameId
                    }
                ]
            };

            sendMessage({ type: 'detectionResult', payload: result });
        }
    } catch (err) {
        sendMessage({ type: 'error', payload: { message: err?.message || String(err) } });
    }
});