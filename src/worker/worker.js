// Cross-platform worker stub (browser Worker and Node worker_threads)
// Accepts ImageBitmap in browser and cleans it up after use.
// In Node, it accepts the lightweight frame messages (frameId).
let isNodeWorker = false;
let parent = null;

// ARController stub - in a real implementation, this would be the actual ARToolKit controller
let arController = null;
let arControllerInitialized = false;

// forwarder guard
let getMarkerForwarderAttached = false;

// Detect environment and setup worker communication
// Only try to import node:worker_threads if we're in a Node.js environment
if (typeof self === 'undefined') {
  // We're in Node.js (no 'self' global)
  try {
    const wt = await import('node:worker_threads').catch(() => null);
    if (wt && wt.parentPort) {
      isNodeWorker = true;
      parent = wt.parentPort;
    }
  } catch (e) {
    // Fallback: not in worker_threads context
    isNodeWorker = false;
    parent = null;
  }
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
  } catch (_e) {
    return { type: null, matrix: null, marker: {} };
  }
}

function attachGetMarkerForwarder() {
  if (!arController || typeof arController.addEventListener !== 'function' || getMarkerForwarderAttached) return;
  try {
    arController.addEventListener('getMarker', (event) => {
      const payload = serializeGetMarkerEvent(event);
      try { console.log('[Worker] getMarker', payload); } catch (_) {}
      sendMessage({ type: 'getMarker', payload });
    });
    getMarkerForwarderAttached = true;
  } catch (_e) {
    // ignore
  }
}

// Initialize ARController with default dimensions if not already initialized
async function initArtoolkit(width = 640, height = 480) {
  if (arControllerInitialized) return true;

  try {
    // Stub implementation - in real usage, this would initialize the actual ARToolKit WASM module
    console.log(`[Worker] Initializing ARToolKit with dimensions ${width}x${height}`);

    // Minimal event-capable stub; real ARController will provide these
    const _listeners = new Map();
    arController = {
      addEventListener: (name, fn) => {
        if (!_listeners.has(name)) _listeners.set(name, []);
        _listeners.get(name).push(fn);
      },
      removeEventListener: (name, fn) => {
        if (!_listeners.has(name)) return;
        _listeners.set(name, _listeners.get(name).filter(x => x !== fn));
      },
      dispatchEvent: (ev) => {
        const name = ev?.type || ev?.name;
        const list = name ? (_listeners.get(name) || []) : [];
        list.forEach(h => h(ev));
      },
      loadMarker: async (patternUrl) => {
        console.log(`[Worker] Loading marker pattern from: ${patternUrl}`);
        await new Promise((r) => setTimeout(r, 50)); // simulate async
        return Math.floor(Math.random() * 1000); // simulated marker id
      },
      trackPatternMarkerId: (markerId, size) => {
        console.log(`[Worker] Tracking pattern marker ID ${markerId} with size ${size}`);
        return true;
      },
      // no-op; real ARController will process canvas/imageData and emit getMarker events
      process: (_source) => {}
    };

    arControllerInitialized = true;
    console.log('[Worker] ARToolKit initialized successfully');

    // If the real ARController is used, this will forward its getMarker events
    attachGetMarkerForwarder();

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
          if (!initSuccess) throw new Error('Failed to initialize ARToolKit');
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
        try {
          // Always close the ImageBitmap to free resources
          imageBitmap.close();
        } catch (_e) {
          // ignore
        }
      } else {
        // No ImageBitmap (Node mode or fallback). Simulate async detection.
        await new Promise((r) => setTimeout(r, 10));
      }

      // Simulated detection result (keeps pipeline functional)
      const fakeMatrix = new Float32Array([
        1,0,0,0,
        0,1,0,0,
        0,0,1,0,
        0,0,0,1
      ]);
      const demoDetection = {
        id: 'demo',
        confidence: 0.9,
        poseMatrix: Array.from(fakeMatrix),
        corners: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
        frameId
      };

      // Post existing structured detectionResult
      sendMessage({ type: 'detectionResult', payload: { detections: [demoDetection] } });

      // Also forward an AR.js-style getMarker event to the main thread
      const vertex = demoDetection.corners.flatMap(c => [c.x, c.y]);
      const getMarkerPayload = {
        type: 0, // ARToolkit.PATTERN_MARKER (placeholder numeric id)
        matrix: demoDetection.poseMatrix,
        marker: {
          idPatt: demoDetection.id,
          cfPatt: demoDetection.confidence,
          vertex
        }
      };
      try { console.log('[Worker] getMarker (derived from detectionResult)', getMarkerPayload); } catch (_e) {}
      sendMessage({ type: 'getMarker', payload: getMarkerPayload });

      // If a real ARController is used and emits 'getMarker', the forwarder will send actual events as well.
    }
  } catch (err) {
    sendMessage({ type: 'error', payload: { message: err?.message || String(err) } });
  }
});