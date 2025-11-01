// Assuming existing imports and setup in src/plugin.js

let detectionWorker;

function enableWorker() {
  detectionWorker = new Worker(new URL('./worker/worker.js', import.meta.url));

  detectionWorker.postMessage({ type: 'init' });

  // Capture engine:update event to post processFrame messages
  core.eventBus.on('engine:update', (frame) => {
    if (frame) {
      detectionWorker.postMessage({ type: 'processFrame', payload: { frameId: frame.id } });
    }
  });

  detectionWorker.addEventListener('message', (ev) => {
    const { type, payload } = ev.data || {};
    if (type === 'ready') {
      console.log('Worker is ready');
    } else if (type === 'detectionResult') {
      payload.detections.forEach(detection => {
        core.eventBus.emit('ar:markerUpdated', {
          id: detection.id,
          poseMatrix: new Float32Array(detection.poseMatrix),
          confidence: detection.confidence,
          corners: detection.corners
        });
      });
    }
  });
}

// Call enableWorker when you want to start the worker
// Example: enableWorker();