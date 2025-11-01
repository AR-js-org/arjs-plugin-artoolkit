// Cross-platform worker stub (browser Worker and Node worker_threads)
// Accepts ImageBitmap in browser and cleans it up after use.
// In Node, it accepts the lightweight frame messages (frameId).
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

onMessage(async (ev) => {
    const { type, payload } = ev || {};
    try {
        if (type === 'init') {
            sendMessage({ type: 'ready' });
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