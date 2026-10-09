/**
 * @fileoverview ARToolKit detection worker.
 *
 * A message pump, nothing more. Converts each incoming `ImageBitmap` to RGBA
 * pixels through an `OffscreenCanvas` and hands them to the detector, then
 * posts the results back. All detection logic lives in
 * `src/detector/artoolkit-detector.js`, where it can be tested without a
 * Worker.
 *
 * Every `processFrame` message is acknowledged with exactly one
 * `detectionResult`, unconditionally - including when both `detected` and
 * `lost` are empty, and for frames skipped outright (no `ImageBitmap`, or the
 * detector not yet constructed). `src/plugin.js` gates frame submission on
 * this acknowledgement arriving (at most one frame in flight at a time), so a
 * silently-dropped frame would wedge submission permanently. An earlier
 * version only acknowledged frames with something to report; that saved a
 * cheap postMessage but let the worker's unbounded FIFO queue grow without
 * bound once detection fell behind the camera's frame rate, starving
 * `loadMarker` behind the backlog. See the "Post-implementation note" on the
 * worker message protocol section of
 * docs/superpowers/specs/2026-09-17-artoolkit5-ts-migration-design.md.
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
 * The frame size this detector's camera projection was sent with, or null
 * before it has been sent. The projection exists only once the first frame
 * has created the ARToolKit state; after that it changes only when
 * `configure` sets `nearPlane` or `farPlane`, which sends it again.
 */
let cameraSent = null;

/** Posts the detector's current camera projection for a `w` x `h` frame. */
function sendCamera(w, h) {
  const projectionMatrix = detector?.getProjectionMatrix();
  if (!projectionMatrix) return;
  cameraSent = { width: w, height: h };
  sendMessage({
    type: "camera",
    payload: {
      projectionMatrix: Array.from(projectionMatrix),
      width: w,
      height: h,
    },
  });
}

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
        cameraSent = null;
        detector = createDetector({
          cameraParametersUrl: payload?.cameraParametersUrl ?? undefined,
          wasmUrl: payload?.wasmUrl ?? undefined,
          minConfidence: payload?.minConfidence ?? undefined,
          detectorOptions: payload?.detectorOptions ?? undefined,
          // Not an `error` message: that one also acknowledges the frame in
          // flight, and this frame is still acknowledged by its own
          // detectionResult. A second acknowledgement would let two frames
          // into flight.
          onInitError: (err) =>
            sendMessage({
              type: "initError",
              payload: {
                message: `ARToolKit initialisation failed (check wasmUrl and cameraParametersUrl): ${err?.message || err}`,
              },
            }),
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

    if (type === "configure" || type === "trackBarcode") {
      const { requestId } = payload || {};
      const resultType = `${type}Result`;

      if (!detector) {
        sendMessage({
          type: resultType,
          payload: { ok: false, error: "Detector not initialised", requestId },
        });
        return;
      }

      // Before the first frame these settle only once the detector applies
      // them, so the reply says whether the request was accepted. The
      // listener is async, so frames keep flowing meanwhile.
      try {
        const result =
          type === "configure"
            ? { config: await detector.configure(payload?.opts) }
            : await detector.trackBarcode(
                payload?.barcodeId,
                payload?.size ?? 1,
              );
        sendMessage({
          type: resultType,
          payload: { ok: true, ...result, requestId },
        });
        // nearPlane and farPlane recompute the projection. Before the first
        // frame there is nothing to resend: the first camera already has them.
        const opts = payload?.opts ?? {};
        if (
          type === "configure" &&
          cameraSent &&
          ("nearPlane" in opts || "farPlane" in opts)
        ) {
          sendCamera(cameraSent.width, cameraSent.height);
        }
      } catch (err) {
        sendMessage({
          type: resultType,
          payload: { ok: false, error: err?.message || String(err), requestId },
        });
      }
      return;
    }

    if (type === "processFrame") {
      const { frameId, imageBitmap, width, height } = payload || {};
      if (!imageBitmap || !detector) {
        // Still acknowledge: the plugin's in-flight flag is only cleared by
        // a detectionResult (or error) arriving, so a silent return here -
        // with no imageBitmap to close and nothing detected - would leave it
        // stuck forever and stop frame submission for good. `skipped` says
        // nothing was analysed, so the plugin does not read the empty lists
        // as every marker going missing.
        sendMessage({
          type: "detectionResult",
          payload: { frameId, detected: [], lost: [], skipped: true },
        });
        return;
      }

      const w = width || imageBitmap.width || 640;
      const h = height || imageBitmap.height || 480;

      // ensureReady and ensureCanvas can both throw; the bitmap is a
      // full-resolution buffer and must be released either way.
      let ready = false;
      try {
        ready = await detector.ensureReady(w, h);
        if (ready) {
          // Once, before this frame's detectionResult, so a renderer has the
          // projection before the first pose it applies.
          if (!cameraSent) sendCamera(w, h);
          ensureCanvas(w, h);

          offscreenCtx.clearRect(0, 0, w, h);
          offscreenCtx.drawImage(imageBitmap, 0, 0, w, h);
        }
      } finally {
        imageBitmap.close?.();
      }

      // No ARToolKit state yet (initialisation failing and backing off):
      // nothing can be analysed, and empty lists would read as every tracked
      // marker missing this frame (#52). Acknowledge it as skipped.
      if (!ready) {
        sendMessage({
          type: "detectionResult",
          payload: { frameId, detected: [], lost: [], skipped: true },
        });
        return;
      }

      const pixels = offscreenCtx.getImageData(0, 0, w, h).data;
      const { detected, lost } = detector.detect(pixels);

      // Always acknowledge, even with nothing detected. This costs one small
      // postMessage per frame and buys back-pressure: it is the plugin's
      // only signal that this frame is done and the next one may be sent.
      sendMessage({
        type: "detectionResult",
        payload: { frameId, detected, lost },
      });
      return;
    }

    if (type === "dispose") {
      detector?.dispose();
      detector = null;
      cameraSent = null;
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
