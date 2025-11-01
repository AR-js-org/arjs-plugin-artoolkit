self.addEventListener('message', async (ev) => {
  const { type, payload } = ev.data || {};
  try {
    if (type === 'init') {
      // Worker init hook. Load WASM or other heavy libraries here in future.
      // Respond ready to main thread.
      self.postMessage({ type: 'ready' });
    } else if (type === 'processFrame') {
      // payload: { imageBitmapTransferable?, width, height }
      // This stub simulates detection latency and returns a fake marker result.
      // In real implementation, run artoolkit detection and return detections.
      const { frameId } = payload || {};
      // Simulate async detection
      await new Promise((r) => setTimeout(r, 10));

      // Fake detection result: one marker with id 'demo' and identity matrix
      const fakeMatrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
      const result = {
        detections: [
          {
            id: 'demo',
            confidence: 0.9,
            poseMatrix: Array.from(fakeMatrix), // structured-clonable
            corners: [ {x:0,y:0}, {x:1,y:0}, {x:1,y:1}, {x:0,y:1} ],
            frameId
          }
        ]
      };

      self.postMessage({ type: 'detectionResult', payload: result });
    }
  } catch (err) {
    self.postMessage({ type: 'error', payload: { message: err.message } });
  }
});