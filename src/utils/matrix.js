// small set of conversion helpers for ARToolKit → Three.js coordinate conventions
export function convertModelViewToThreeMatrix(modelViewArray) {
    // Input: Float32Array(16) from artoolkit (row-major or library-specific)
    // Output: Float32Array(16) ready to use with THREE.Matrix4.fromArray (column-major)
    // Concrete conversion will be implemented when integrating artoolkit5-js.
    const out = new Float32Array(16);
    for (let i = 0; i < 16; i++) out[i] = modelViewArray[i];
    return out;
}