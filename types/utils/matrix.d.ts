/**
 * @fileoverview Matrix conversion utilities for ARToolKit ↔ Three.js transformations
 *
 * Provides coordinate system conversion helpers for transforming ARToolKit
 * modelView matrices into Three.js-compatible matrix format.
 */
/**
 * Converts an ARToolKit modelView matrix to Three.js Matrix4 compatible format.
 *
 * ARToolKit and Three.js may use different coordinate conventions (row-major vs column-major).
 * This function handles the transformation to ensure proper rendering in Three.js scenes.
 *
 * @param {Float32Array|Array<number>} modelViewArray - 16-element matrix from ARToolKit
 *        representing the marker's pose in camera space
 * @returns {Float32Array} 16-element matrix ready for THREE.Matrix4.fromArray()
 *
 * @example
 * const arMatrix = new Float32Array(16); // from ARToolKit detection
 * const threeMatrix = convertModelViewToThreeMatrix(arMatrix);
 * threeObject.matrix.fromArray(threeMatrix);
 *
 * @note Concrete conversion logic will be refined when fully integrating artoolkit5-js
 */
export function convertModelViewToThreeMatrix(modelViewArray: Float32Array | Array<number>): Float32Array;
//# sourceMappingURL=matrix.d.ts.map