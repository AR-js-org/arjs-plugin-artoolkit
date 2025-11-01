// Cross-platform worker stub (browser Worker and Node worker_threads)
let isNodeWorker = false;
let parent = null;

try {
    // In Node worker_threads, require is available and worker_threads.parentPort exists.
    // Use dynamic require to avoid bundling issues in browser builds.
    // If this throws, assume browser worker environment.
    // eslint-disable-next-line no-global-assign
    const wt = await import('node:worker_threads').catch(() => null);
    if (wt && wt.parentPort) {
        isNodeWorker = true;
        parent = wt.parentPort;
    }
} catch (e) {
    // Not running under Node worker_threads
    isNodeWorker = false;
    parent = null;
}

// Helper abstractions
function onMessage(fn) {
    if (isNodeWorker) {
        parent.on('message', (msg) => fn(msg));
    } else {
        // browser worker global is `self`
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

// Worker implementation (same logic as before)
onMessage(async (ev) => {
    const { type, payload } = ev || {};
    try {
        if (type === 'init') {
            // Worker init hook. Load WASM or other heavy libraries here in future.
            // Respond ready to main thread.
            sendMessage({ type: 'ready' });
        } else if (type === 'processFrame') {
            // payload: { imageBitmapTransferable?, width, height, frameId }
            // This stub simulates detection latency and returns a fake marker result.
            const { frameId } = payload || {};
            // Simulate async detection
            await new Promise((r) => setTimeout(r, 10));

            // Fake detection result: one marker "demo" and identity matrix
            const fakeMatrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
            const result = {
                detections: [
                    {
                        id: 'demo',
                        confidence: 0.9,
                        poseMatrix: Array.from(fakeMatrix), // structured-clonable for postMessage
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