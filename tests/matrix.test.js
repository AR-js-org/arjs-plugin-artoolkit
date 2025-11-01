import { describe, it, expect } from 'vitest';
import { convertModelViewToThreeMatrix } from '../src/utils/matrix.js';

describe('matrix utils', () => {
    it('returns a Float32Array of length 16', () => {
        const inArr = new Float32Array(16).fill(0);
        const out = convertModelViewToThreeMatrix(inArr);
        expect(out).toBeInstanceOf(Float32Array);
        expect(out.length).toBe(16);
    });
});