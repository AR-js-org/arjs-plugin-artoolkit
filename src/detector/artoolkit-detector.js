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
  configureDetector,
  createARToolKitState,
  disposeARToolKitState,
  getCameraProjectionMatrix,
  loadPatternMarker,
  processFrame,
  trackBarcodeMarker,
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
 * Detection modes that include matrix (barcode) detection. ARToolKit only
 * reports barcodes in one of these.
 */
const MATRIX_MODES = new Set(["matrix", "color_and_matrix", "mono_and_matrix"]);

/**
 * Normalise a confidence floor to artoolkit5-ts's per-family shape.
 *
 * A bare number applies to both families, which keeps the pre-0.3.0 meaning
 * of the option: one threshold for everything.
 *
 * @param {number|{pattern?: number, barcode?: number}|undefined} value
 * @returns {{pattern?: number, barcode?: number}|undefined}
 */
export function normalizeMinConfidence(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return { pattern: value, barcode: value };
  return value;
}

/**
 * The matrix-capable detection mode closest to `mode`.
 *
 * Keeps the image type the caller chose: a mono pipeline stays mono.
 *
 * @param {string|undefined} mode - Current detection mode; undefined is the
 *   engine default, `'color'`
 * @returns {string}
 */
export function matrixCapableMode(mode) {
  if (mode && MATRIX_MODES.has(mode)) return mode;
  return mode === "mono" ? "mono_and_matrix" : "color_and_matrix";
}

/**
 * Split detector options into the single-key steps they are applied in.
 *
 * artoolkit5-ts's `configureDetector` applies a call's keys one after another
 * and stops at the first invalid one, leaving the earlier ones applied. One
 * key per call means a rejected value fails alone, and the recorded
 * configuration matches what the engine actually took. `minConfidence` is
 * split per family for the same reason.
 *
 * @param {Object} opts - Options with `minConfidence` already normalised
 * @returns {Array<Object>} One single-key options object per step
 * @private
 */
function optionSteps(opts) {
  const steps = [];
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) continue;
    if (key === "minConfidence" && value && typeof value === "object") {
      for (const [family, floor] of Object.entries(value)) {
        if (floor !== undefined) {
          steps.push({ minConfidence: { [family]: floor } });
        }
      }
    } else {
      steps.push({ [key]: value });
    }
  }
  return steps;
}

/**
 * Record an applied step in a configuration, as artoolkit5-ts applies it:
 * `minConfidence` changes only the families present.
 *
 * @param {Object} config - Configuration to update in place
 * @param {Object} step - One step from {@link optionSteps}
 * @private
 */
function mergeStep(config, step) {
  if ("minConfidence" in step) {
    config.minConfidence = { ...config.minConfidence, ...step.minConfidence };
  } else {
    Object.assign(config, step);
  }
}

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
 * @param {number|{pattern?: number, barcode?: number}} [options.minConfidence=0.6]
 *   - Drop detections below this confidence (0-1), as one number for both
 *   families or per family. Applied by artoolkit5-ts through
 *   `configureDetector`; the default matches the gate the worker applied
 *   before the artoolkit5-ts migration.
 * @param {Object} [options.detectorOptions] - Any other artoolkit5-ts
 *   `DetectorOptions` (`detectionMode`, `matrixCodeType`, `threshold`, ...),
 *   applied once the state exists.
 * @param {(err: Error) => void} [options.onInitError] - Called on the first
 *   failed initialisation attempt of a retry cycle, so a missing WASM binary
 *   surfaces at once instead of only through a later timeout. Retries carry on
 *   regardless.
 * @returns {Detector}
 */
export function createDetector(options = {}) {
  const {
    cameraParametersUrl = DEFAULT_CAMERA_URL,
    wasmUrl,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    detectorOptions = {},
    onInitError,
  } = options;

  /** Options given at construction, applied first when the state is created. */
  const initialOptions = {
    ...detectorOptions,
    minConfidence: normalizeMinConfidence(minConfidence),
  };

  /**
   * The configuration in effect. Before the state exists, the configuration
   * requested so far, which is what {@link trackBarcode} decides the detection
   * mode from; it is rebuilt from what the engine accepts once the state is
   * created.
   *
   * @type {Object}
   */
  let config = {};
  for (const step of optionSteps(initialOptions)) mergeStep(config, step);

  /**
   * `configure` and `trackBarcode` requests made before the state exists, run
   * in order once it does. Each settles only then, so a caller learns whether
   * its request was actually accepted rather than that it was queued.
   *
   * @type {Array<{run: () => Object, resolve: Function, reject: Function}>}
   */
  let queue = [];

  /** @type {Object|null} */
  let state = null;
  /**
   * The camera projection for `state`, taken once when it is created: it
   * depends only on the camera parameters and the frame size, both fixed.
   * @type {Float64Array|null}
   */
  let projectionMatrix = null;
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
        projectionMatrix = getCameraProjectionMatrix(created);
        failCount = 0;
        failedUntil = 0;

        // Everything is set up before readiness is published, so nothing
        // waiting on it sees a half-configured engine. Construction options
        // come first, then queued requests in the order they were made:
        // barcodes are only detected once the engine is in a matrix-capable
        // mode. A refused construction option is left out and does not stop
        // the rest; a refused request fails on its own.
        config = {};
        let initialError = null;
        try {
          applyOptions(initialOptions);
        } catch (err) {
          initialError = err;
        }
        const pending = queue;
        queue = [];
        for (const { run, resolve, reject } of pending) {
          try {
            resolve(run());
          } catch (err) {
            reject(err);
          }
        }

        if (!readySettled) resolveReady(state);
        // Thrown after the state is committed, so it is reported once instead
        // of being retried as if initialisation had failed.
        if (initialError) throw initialError;
        return true;
      } catch (err) {
        if (state) throw err;
        if (failCount === 0) onInitError?.(err);
        failCount = Math.min(failCount + 1, MAX_FAIL_COUNT);
        failedUntil =
          Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failCount);

        // Once retries have been exhausted, fail the waiters rather than
        // leaving them on a promise that will never resolve.
        if (failCount >= MAX_FAIL_COUNT && !readySettled) {
          const failure = new Error(
            `ARToolKit initialisation failed ${failCount} times: ${err?.message || err}`,
          );
          rejectReady(failure);
          rejectQueue(failure);
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
   * Apply options to the state one key at a time, recording each one the
   * engine accepts in `config`.
   *
   * @param {Object} opts - Options with `minConfidence` already normalised
   * @throws {Error} The first rejection, after every other key has been applied
   * @private
   */
  function applyOptions(opts) {
    let firstError = null;
    for (const step of optionSteps(opts)) {
      try {
        configureDetector(state, step);
        mergeStep(config, step);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
  }

  /**
   * Run `run` against the state now if it exists, otherwise once it is
   * created.
   *
   * @param {() => Object} run - Work that needs the state; may throw
   * @returns {Promise<Object>} Settles with `run`'s result or error
   * @private
   */
  function request(run) {
    if (disposed) return Promise.reject(new Error("Detector disposed"));
    if (state) {
      try {
        return Promise.resolve(run());
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
    });
  }

  /**
   * Fail every queued request.
   *
   * @param {Error} err
   * @private
   */
  function rejectQueue(err) {
    const pending = queue;
    queue = [];
    for (const { reject } of pending) reject(err);
  }

  /**
   * A copy of `config` the caller cannot use to change it.
   *
   * @returns {Object}
   * @private
   */
  function snapshot() {
    const copy = { ...config };
    if (copy.minConfidence) copy.minConfidence = { ...copy.minConfidence };
    return copy;
  }

  /**
   * Change detector settings.
   *
   * Only the keys present are changed, and `minConfidence` only for the
   * families present. Applied at once when the state exists, otherwise when it
   * is created; the returned promise settles only then, so an option
   * artoolkit5-ts refuses rejects this call rather than surfacing later.
   *
   * Keys are applied one at a time: when one is refused, the others in the
   * same call still take effect, and the refused one stays out of the
   * configuration.
   *
   * @param {Object} [opts] - artoolkit5-ts `DetectorOptions`; `minConfidence`
   *   may also be a single number
   * @returns {Promise<Object>} The full configuration now in effect
   */
  function configure(opts = {}) {
    const partial = { ...opts };
    if ("minConfidence" in partial) {
      partial.minConfidence = normalizeMinConfidence(partial.minConfidence);
    }
    // Before the state exists, record the request so a trackBarcode() queued
    // after it decides the detection mode from it.
    if (!state && !disposed) {
      for (const step of optionSteps(partial)) mergeStep(config, step);
    }
    return request(() => {
      applyOptions(partial);
      return snapshot();
    });
  }

  /**
   * Track a barcode (matrix code) marker.
   *
   * Barcodes need no file: the ID is read off the marker itself. If the
   * detection mode cannot see barcodes it is switched to the closest one that
   * can, with a warning — tracking a barcode the engine never reports is never
   * what the caller wants.
   *
   * Registered at once when the state exists, otherwise when it is created;
   * the returned promise settles only then.
   *
   * @param {number} barcodeId - ID encoded in the marker
   * @param {number} [size=1] - Marker width in world units
   * @returns {Promise<{markerId: number, size: number, detectionMode: string}>}
   *   Rejects at once if disposed or `barcodeId` is not a non-negative
   *   integer, and later if artoolkit5-ts refuses the registration
   */
  function trackBarcode(barcodeId, size = 1) {
    if (disposed) return Promise.reject(new Error("Detector disposed"));
    if (!Number.isInteger(barcodeId) || barcodeId < 0) {
      return Promise.reject(new Error(`Invalid barcodeId: ${barcodeId}`));
    }

    const mode = matrixCapableMode(config.detectionMode);
    if (mode !== config.detectionMode) {
      console.warn(
        `[ArtoolkitDetector] detectionMode '${config.detectionMode ?? "color"}' cannot detect barcodes; switching to '${mode}'.`,
      );
      // Every mode matrixCapableMode returns is valid, and a failure here
      // would only mean the state is gone, which the request below reports.
      configure({ detectionMode: mode }).catch(() => {});
    }

    return request(() => {
      trackBarcodeMarker(state, barcodeId, size);
      return { markerId: barcodeId, size, detectionMode: mode };
    });
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

    // Confidence filtering happens inside processFrame, per family, from the
    // minConfidence handed to configureDetector.
    const result = processFrame(state, pixels);

    // The native 3x4 Float64Array pose is deliberately not forwarded: nothing
    // downstream reads it, and it costs 96 bytes per marker per frame across
    // the worker boundary.
    //
    // `vertex` is forwarded, and is the one field here that is not a view onto
    // a buffer artoolkit5-ts reuses next frame - it allocates a fresh array per
    // detection, so it survives the structured clone and can be retained.
    //
    // `dir` travels with it because it is the only thing that makes `vertex`
    // interpretable: corner order follows the square tracer, so `vertex[0]` is
    // a different printed corner depending on how the marker is turned. One
    // number per detection, and without it a consumer cannot name a corner at
    // all.
    const detected = result.detected.map(
      ({ id, type, confidence, matrixGL, vertex, dir }) => ({
        id,
        type,
        confidence,
        matrixGL,
        vertex,
        dir,
      }),
    );

    return { detected, lost: result.lost };
  }

  /**
   * Release the ARToolKit state and its WASM resources.
   *
   * Idempotent. After disposal {@link detect} returns empty results rather than
   * throwing, so an in-flight frame cannot crash the worker. Also fails any
   * {@link loadPattern}, {@link configure} or {@link trackBarcode} call still
   * waiting on readiness, so a caller blocked on
   * a detector that will never initialise is not left hanging forever. A state
   * that finishes initialising after this call is freed rather than kept, so
   * it cannot leak.
   *
   * @returns {void}
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    const err = new Error("Detector disposed before initialisation completed");
    if (!readySettled) rejectReady(err);
    rejectQueue(err);
    if (state) {
      disposeARToolKitState(state);
      state = null;
      projectionMatrix = null;
    }
  }

  /**
   * The camera projection matrix artoolkit5-ts computed from the camera
   * parameters, to pair with the detections' `matrixGL`.
   *
   * @returns {Float64Array|null} Sixteen values, or null before the state exists
   */
  function getProjectionMatrix() {
    return projectionMatrix;
  }

  /**
   * @typedef {Object} Detector
   * @property {(width: number, height: number) => Promise<boolean>} ensureReady
   * @property {(patternUrl: string, size?: number) => Promise<number>} loadPattern
   * @property {(opts?: Object) => Promise<Object>} configure
   * @property {(barcodeId: number, size?: number) => Promise<{markerId: number, size: number, detectionMode: string}>} trackBarcode
   * @property {(pixels: Uint8ClampedArray) => {detected: Array<Object>, lost: Array<Object>}} detect
   * @property {() => void} dispose
   * @property {() => (Float64Array|null)} getProjectionMatrix
   */
  return {
    ensureReady,
    loadPattern,
    configure,
    trackBarcode,
    detect,
    dispose,
    getProjectionMatrix,
  };
}
