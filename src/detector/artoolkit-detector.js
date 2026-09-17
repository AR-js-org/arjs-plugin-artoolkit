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

  let resolveReady;
  let rejectReady;
  let readySettled = false;

  /**
   * Resolves with the ARToolKit state once it exists; rejects when the current
   * initialisation cycle gives up, or when the detector is disposed.
   *
   * Re-armed after a rejection. A settled promise can never change state, so a
   * single long-lived promise would leave `loadPattern` permanently broken
   * after one exhausted retry cycle — even once initialisation later succeeds
   * and the detector is genuinely healthy again.
   *
   * @type {Promise<Object>}
   */
  let readyPromise;

  /**
   * Install a fresh unsettled `readyPromise` and its settle functions.
   *
   * @private
   */
  function armReadyPromise() {
    readySettled = false;
    readyPromise = new Promise((resolve, reject) => {
      resolveReady = (value) => {
        readySettled = true;
        resolve(value);
      };
      rejectReady = (err) => {
        readySettled = true;
        reject(err);
      };
    });

    // Nothing observes this promise until loadPattern awaits it. Attach a no-op
    // handler so settling it rejected with no consumer does not raise an
    // unhandled-rejection warning.
    readyPromise.catch(() => {});
  }

  armReadyPromise();

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
        const created = await createARToolKitState(
          width,
          height,
          cameraParametersUrl,
          wasmUrl,
        );

        // dispose() may have run while this was in flight. It saw state === null
        // and freed nothing, and a second dispose() is a no-op, so committing
        // this state would leak it.
        if (disposed) {
          disposeARToolKitState(created);
          return false;
        }

        state = created;
        failCount = 0;
        failedUntil = 0;
        if (!readySettled) resolveReady(state);
        return true;
      } catch (err) {
        state = null;
        failCount = Math.min(failCount + 1, MAX_FAIL_COUNT);
        failedUntil =
          Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failCount);

        // Once retries have been exhausted, fail the waiters rather than
        // leaving them on a promise that will never resolve.
        if (failCount >= MAX_FAIL_COUNT && !readySettled) {
          rejectReady(
            new Error(
              `ARToolKit initialisation failed ${failCount} times: ${err?.message || err}`,
            ),
          );
          // Anyone already waiting gets that rejection. Re-arm so a later
          // successful attempt can serve new callers instead of handing them a
          // permanently rejected promise.
          armReadyPromise();
        }
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
   * Rejects if the detector is disposed — either already, at the time of the
   * call, or while this call was waiting on readiness — rather than reaching
   * through to a freed state. Also rejects if the current initialisation
   * cycle has given up after repeated failures, instead of leaving the caller
   * waiting on a promise that would never settle. That rejection is not
   * permanent: {@link ensureReady} keeps retrying, and once an attempt
   * eventually succeeds, later calls resolve normally again.
   *
   * @param {string} patternUrl - URL of the .patt file
   * @param {number} [size=1] - Marker width in world units
   * @returns {Promise<number>} The marker ID assigned by ARToolKit
   */
  async function loadPattern(patternUrl, size = 1) {
    if (disposed) throw new Error("Detector disposed");
    if (loaded.has(patternUrl)) return loaded.get(patternUrl);
    if (loading.has(patternUrl)) return loading.get(patternUrl);

    const pending = (async () => {
      const readyState = await readyPromise;
      // readyPromise keeps handing out the state it resolved with, which
      // dispose() may since have freed.
      if (disposed) throw new Error("Detector disposed");
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
    const filtered =
      minConfidence > 0
        ? result.detected.filter((pose) => pose.confidence >= minConfidence)
        : result.detected;

    // The native 3x4 Float64Array pose is deliberately not forwarded: nothing
    // downstream reads it, and it costs 96 bytes per marker per frame across
    // the worker boundary.
    const detected = filtered.map(({ id, type, confidence, matrixGL }) => ({
      id,
      type,
      confidence,
      matrixGL,
    }));

    return { detected, lost: result.lost };
  }

  /**
   * Release the ARToolKit state and its WASM resources.
   *
   * Idempotent. After disposal {@link detect} returns empty results rather than
   * throwing, so an in-flight frame cannot crash the worker. Also fails any
   * {@link loadPattern} call still waiting on readiness, so a caller blocked on
   * a detector that will never initialise is not left hanging forever. A state
   * that finishes initialising after this call is freed rather than kept, so
   * it cannot leak.
   *
   * @returns {void}
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (!readySettled) {
      rejectReady(
        new Error("Detector disposed before initialisation completed"),
      );
    }
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
