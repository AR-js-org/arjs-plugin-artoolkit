/**
 * @fileoverview Matrix helpers for ARToolKit poses.
 */

/**
 * Copy a 16-element pose matrix into a fresh `Float32Array`.
 *
 * @deprecated No conversion is needed for poses from artoolkit5-ts. The
 * `matrix` field on `ar:markerFound` and `ar:markerUpdated` is already
 * `matrixGL`: 4x4 column-major right-handed, ready for WebGL and for
 * `THREE.Matrix4.fromArray()`. This function now only makes a defensive copy,
 * and is kept so existing callers do not break. It will be removed in a future
 * release.
 *
 * @param {Float32Array|Array<number>} modelViewArray - 16-element pose matrix
 * @returns {Float32Array} A copy of the input
 *
 * @example
 * // Preferred: use the event payload directly.
 * eventBus.on('ar:markerFound', ({ matrix }) => {
 *   object.matrixAutoUpdate = false;
 *   object.matrix.fromArray(matrix);
 * });
 */
export function convertModelViewToThreeMatrix(modelViewArray) {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = modelViewArray[i];
  return out;
}
