// Cross-platform worker for ARToolKit marker detection
// Supports ImageBitmap in browser and lightweight frame messages in Node (worker_threads)
import { createDetector } from './artoolkit/loader.js';

let isNodeWorker = false;
let parent = null;

// ARToolKit detector instance
let detector = null;
let offscreenCanvas = null;
let canvasContext = null;
let canvasWidth = 0;
let canvasHeight = 0;

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

/**
 * Initialize OffscreenCanvas for ImageBitmap processing
 */
function initOffscreenCanvas(width, height) {
    if (!isNodeWorker && typeof OffscreenCanvas !== 'undefined') {
        if (!offscreenCanvas || canvasWidth !== width || canvasHeight !== height) {
            console.log(`[Worker] Creating OffscreenCanvas ${width}x${height}`);
            offscreenCanvas = new OffscreenCanvas(width, height);
            canvasContext = offscreenCanvas.getContext('2d', { willReadFrequently: true });
            canvasWidth = width;
            canvasHeight = height;
        }
    }
}

/**
 * Process ImageBitmap and extract ImageData for detection
 */
function processImageBitmap(imageBitmap) {
    if (!imageBitmap) return null;
    
    try {
        const width = imageBitmap.width;
        const height = imageBitmap.height;
        
        // Initialize or reuse OffscreenCanvas
        initOffscreenCanvas(width, height);
        
        if (!canvasContext) {
            console.warn('[Worker] OffscreenCanvas not available, skipping detection');
            return null;
        }
        
        // Draw ImageBitmap to canvas
        canvasContext.drawImage(imageBitmap, 0, 0);
        
        // Extract ImageData
        const imageData = canvasContext.getImageData(0, 0, width, height);
        
        return imageData;
    } catch (err) {
        console.error('[Worker] Failed to process ImageBitmap:', err);
        return null;
    }
}

onMessage(async (ev) => {
    const { type, payload } = ev || {};
    try {
        if (type === 'init') {
            // Initialize ARToolKit detector
            console.log('[Worker] Initializing ARToolKit detector...');
            try {
                detector = await createDetector();
                console.log('[Worker] ARToolKit detector initialized');
            } catch (err) {
                console.error('[Worker] Failed to initialize detector:', err);
                sendMessage({ type: 'error', payload: { message: 'Failed to initialize ARToolKit detector' } });
            }
            sendMessage({ type: 'ready' });
        } else if (type === 'processFrame') {
            // Browser: payload.imageBitmap may exist
            const { imageBitmap, frameId, width, height } = payload || {};

            let detections = [];

            // If ImageBitmap present, run detection on it
            if (imageBitmap && typeof imageBitmap.close === 'function') {
                try {
                    // Process ImageBitmap → ImageData
                    const imageData = processImageBitmap(imageBitmap);
                    
                    if (imageData && detector) {
                        // Run detection
                        detections = detector.detect(imageData);
                        
                        // Log detection events in worker console
                        if (detections.length > 0) {
                            console.log(`[Worker] Detected ${detections.length} marker(s):`, 
                                detections.map(d => `ID=${d.id}, confidence=${d.confidence?.toFixed(2)}`).join(', '));
                        }
                    }
                } catch (err) {
                    console.error('[Worker] Detection failed:', err);
                } finally {
                    // Always close the ImageBitmap to free resources
                    try {
                        imageBitmap.close();
                    } catch (e) {
                        // ignore
                    }
                }
            } else {
                // No ImageBitmap (Node mode or fallback). Keep stub behavior.
                console.log('[Worker] Processing frame in Node mode (frameId:', frameId, ')');
            }

            const result = {
                detections: detections,
                frameId
            };

            sendMessage({ type: 'detectionResult', payload: result });
        }
    } catch (err) {
        console.error('[Worker] Error:', err);
        sendMessage({ type: 'error', payload: { message: err?.message || String(err) } });
    }
});