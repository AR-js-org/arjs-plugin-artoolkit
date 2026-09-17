/**
 * @fileoverview ARToolKit detection worker.
 *
 * A message pump, nothing more. Converts each incoming `ImageBitmap` to RGBA
 * pixels through an `OffscreenCanvas` and hands them to the detector, then
 * posts the results back. All detection logic lives in
 * `src/detector/artoolkit-detector.js`, where it can be tested without a
 * Worker.
 *
 * Browser-only: requires `OffscreenCanvas` and the Worker global scope.
 *
 * @module worker/worker
 */

import { createDetector } from "../detector/artoolkit-detector.js";

/** @type {ReturnType<typeof createDetector>|null} */
let detector = null;

let offscreenCanvas = null;
let offscreenCtx = null;
let canvasW = 0;
let canvasH = 0;
let hasAnnouncedReady = false;

/**
 * Post a message to the main thread.
 *
 * @param {Object} msg - Message with a `type` and optional `payload`
 * @private
 */
function sendMessage(msg) {
  self.postMessage(msg);
}

/**
 * Ensure the OffscreenCanvas matches the frame size, reallocating on change.
 *
 * @param {number} width - Frame width in pixels
 * @param {number} height - Frame height in pixels
 * @private
 */
function ensureCanvas(width, height) {
  if (offscreenCanvas && canvasW === width && canvasH === height) return;
  canvasW = width;
  canvasH = height;
  offscreenCanvas = new OffscreenCanvas(width, height);
  offscreenCtx = offscreenCanvas.getContext("2d", {
    willReadFrequently: true,
  });
}

self.addEventListener("message", async (ev) => {
  const { type, payload } = ev.data || {};

  try {
    if (type === "init") {
      // The plugin's watchdog resends init if `ready` was slow to arrive.
      // Constructing a second detector here would discard the ARToolKit state
      // and every pattern loaded so far, so init is idempotent.
      if (!detector) {
        detector = createDetector({
          cameraParametersUrl: payload?.cameraParametersUrl ?? undefined,
          wasmUrl: payload?.wasmUrl ?? undefined,
          minConfidence: payload?.minConfidence ?? undefined,
        });
      }

      // No dimensions are sent here, and none exist yet at this point in the
      // lifecycle. The detector becomes ready from `processFrame` below, once
      // a real frame supplies real dimensions for `createARToolKitState`.
      if (!hasAnnouncedReady) {
        sendMessage({ type: "ready" });
        hasAnnouncedReady = true;
      }
      return;
    }

    if (type === "loadMarker") {
      const { patternUrl, size = 1, requestId } = payload || {};

      if (!patternUrl) {
        sendMessage({
          type: "loadMarkerResult",
          payload: {
            ok: false,
            error: "Missing patternUrl parameter",
            requestId,
          },
        });
        return;
      }

      if (!detector) {
        sendMessage({
          type: "loadMarkerResult",
          payload: { ok: false, error: "Detector not initialised", requestId },
        });
        return;
      }

      try {
        const markerId = await detector.loadPattern(patternUrl, size);
        sendMessage({
          type: "loadMarkerResult",
          payload: { ok: true, markerId, size, requestId },
        });
      } catch (err) {
        sendMessage({
          type: "loadMarkerResult",
          payload: { ok: false, error: err?.message || String(err), requestId },
        });
      }
      return;
    }

    if (type === "processFrame") {
      const { frameId, imageBitmap, width, height } = payload || {};
      if (!imageBitmap || !detector) return;

      const w = width || imageBitmap.width || 640;
      const h = height || imageBitmap.height || 480;

      await detector.ensureReady(w, h);
      ensureCanvas(w, h);

      offscreenCtx.clearRect(0, 0, w, h);
      offscreenCtx.drawImage(imageBitmap, 0, 0, w, h);
      imageBitmap.close?.();

      const pixels = offscreenCtx.getImageData(0, 0, w, h).data;
      const { detected, lost } = detector.detect(pixels);

      if (detected.length || lost.length) {
        sendMessage({
          type: "detectionResult",
          payload: { frameId, detected, lost },
        });
      }
      return;
    }

    if (type === "dispose") {
      detector?.dispose();
      detector = null;
      return;
    }
  } catch (err) {
    sendMessage({
      type: "error",
      payload: { message: err?.message || String(err) },
    });
  }
});

// Announce readiness immediately, in case `init` is delayed.
if (!hasAnnouncedReady) {
  sendMessage({ type: "ready" });
  hasAnnouncedReady = true;
}
