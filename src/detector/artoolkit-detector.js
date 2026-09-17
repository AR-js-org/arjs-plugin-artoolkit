/**
 * @fileoverview DOM-free detection core wrapping artoolkit5-ts.
 *
 * Takes RGBA pixels and returns marker poses. Deliberately free of `self`,
 * `OffscreenCanvas` and `postMessage` so it can be unit-tested without a
 * Worker; those concerns belong to `src/worker/worker.js`.
 *
 * @module detector/artoolkit-detector
 */

import {
  createARToolKitState,
  disposeARToolKitState,
  loadPatternMarker,
  processFrame,
  trackMarker,
} from "@ar-js-org/artoolkit5-ts";

/** Camera calibration used when the caller supplies none. */
const DEFAULT_CAMERA_URL =
  "https://raw.githack.com/AR-js-org/AR.js/master/data/data/camera_para.dat";

/** Longest backoff between failed initialisation attempts, in milliseconds. */
const MAX_BACKOFF_MS = 30000;

/** Hard ceiling on the backoff exponent, so the delay cannot run away. */
const MAX_FAIL_COUNT = 6;

/**
 * Confidence floor applied when the caller supplies none.
 *
 * Matches the gate the worker applied before the artoolkit5-ts migration, so
 * detection behaviour is preserved rather than silently loosened.
 */
const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Create a detector.
 *
 * Construction is cheap and synchronous: no WASM is loaded until
 * {@link Detector#ensureReady} supplies real frame dimensions.
 * `createARToolKitState` fixes width and height permanently, so guessing them
 * at construction would calibrate detection against the wrong intrinsics.
 *
 * @param {Object} [options]
 * @param {string} [options.cameraParametersUrl] - Camera calibration file URL
 * @param {string} [options.wasmUrl] - Explicit URL for the ARToolKit WASM binary
 * @param {number} [options.minConfidence=0.6] - Drop detections below this
 *   confidence (0-1). The default matches the gate the worker applied before
 *   this migration, so detection behaviour is unchanged. artoolkit5-ts can
 *   filter per family via `configureDetector`, which is where this belongs once
 *   that option is exposed.
 * @returns {Detector}
 */
export function createDetector(options = {}) {
  const {
    cameraParametersUrl = DEFAULT_CAMERA_URL,
    wasmUrl,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
  } = options;

  /** @type {Object|null} */
  let state = null;
  /** @type {Promise<boolean>|null} */
  let initInProgress = null;
  let failCount = 0;
  let failedUntil = 0;
  let disposed = false;

  /** Resolves once state exists, so loadPattern can be called before readiness. */
  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  /** @type {Map<string, number>} patternUrl -> markerId */
  const loaded = new Map();
  /** @type {Map<string, Promise<number>>} patternUrl -> in-flight load */
  const loading = new Map();

  /**
   * Create the ARToolKit state if it does not exist yet.
   *
   * Applies exponential backoff after a failure so a missing WASM binary does
   * not trigger a fresh attempt on every frame.
   *
   * @param {number} width - Frame width in pixels
   * @param {number} height - Frame height in pixels
   * @returns {Promise<boolean>} True once state exists
   */
  async function ensureReady(width, height) {
    if (disposed) return false;
    if (state) return true;

    if (Date.now() < failedUntil) return false;
    if (initInProgress) return initInProgress;

    initInProgress = (async () => {
      try {
        state = await createARToolKitState(
          width,
          height,
          cameraParametersUrl,
          wasmUrl,
        );
        failCount = 0;
        failedUntil = 0;
        resolveReady(state);
        return true;
      } catch (err) {
        state = null;
        failCount = Math.min(failCount + 1, MAX_FAIL_COUNT);
        failedUntil =
          Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failCount);
        return false;
      } finally {
        initInProgress = null;
      }
    })();

    return initInProgress;
  }

  /**
   * Load a pattern marker and start tracking it.
   *
   * Deduplicated by URL: loading the same pattern twice returns the same ID
   * without a second network fetch. Safe to call before {@link ensureReady} —
   * the load waits for state to exist rather than failing.
   *
   * @param {string} patternUrl - URL of the .patt file
   * @param {number} [size=1] - Marker width in world units
   * @returns {Promise<number>} The marker ID assigned by ARToolKit
   */
  async function loadPattern(patternUrl, size = 1) {
    if (loaded.has(patternUrl)) return loaded.get(patternUrl);
    if (loading.has(patternUrl)) return loading.get(patternUrl);

    const pending = (async () => {
      const readyState = await readyPromise;
      const markerId = await loadPatternMarker(readyState, patternUrl);
      trackMarker(readyState, markerId, size);
      loaded.set(patternUrl, markerId);
      loading.delete(patternUrl);
      return markerId;
    })().catch((err) => {
      loading.delete(patternUrl);
      throw err;
    });

    loading.set(patternUrl, pending);
    return pending;
  }

  /**
   * Detect markers in one frame.
   *
   * @param {Uint8ClampedArray} pixels - RGBA pixel data for the whole frame
   * @returns {{detected: Array<Object>, lost: Array<Object>}} Poses found this
   *   frame and markers that disappeared since the last one. Both empty when
   *   the detector is not ready.
   */
  function detect(pixels) {
    if (!state || disposed) return { detected: [], lost: [] };

    const result = processFrame(state, pixels);
    const detected =
      minConfidence > 0
        ? result.detected.filter((pose) => pose.confidence >= minConfidence)
        : result.detected;

    return { detected, lost: result.lost };
  }

  /**
   * Release the ARToolKit state and its WASM resources.
   *
   * Idempotent. After disposal {@link detect} returns empty results rather than
   * throwing, so an in-flight frame cannot crash the worker.
   *
   * @returns {void}
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (state) {
      disposeARToolKitState(state);
      state = null;
    }
  }

  /**
   * @typedef {Object} Detector
   * @property {(width: number, height: number) => Promise<boolean>} ensureReady
   * @property {(patternUrl: string, size?: number) => Promise<number>} loadPattern
   * @property {(pixels: Uint8ClampedArray) => {detected: Array<Object>, lost: Array<Object>}} detect
   * @property {() => void} dispose
   */
  return { ensureReady, loadPattern, detect, dispose };
}
