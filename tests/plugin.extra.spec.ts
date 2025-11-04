import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtoolkitPlugin } from '../src/plugin.js';
import { createEventBus } from './setupTests';

describe('ArtoolkitPlugin (extra coverage)', () => {
    let core: { eventBus: ReturnType<typeof createEventBus> };
    beforeEach(() => {
        core = { eventBus: createEventBus() };
    });

    it('forwards ar:getMarker payloads to the event bus', async () => {
        const plugin = new ArtoolkitPlugin({ worker: false });
        await plugin.init(core);

        const handler = vi.fn();
        core.eventBus.on('ar:getMarker', handler);

        // @ts-ignore private use for testing
        plugin._onWorkerMessage({ data: { type: 'getMarker', payload: { type: 0, matrix: new Array(16).fill(1), marker: { idPatt: 7, cfPatt: 0.9 } } } });

        expect(handler).toHaveBeenCalledTimes(1);
        const payload = handler.mock.calls[0][0];
        expect(Array.isArray(payload.matrix) || payload.matrix instanceof Float32Array).toBeTruthy();
    });

    it('emits ar:workerError on error messages', async () => {
        const plugin = new ArtoolkitPlugin({ worker: false });
        await plugin.init(core);

        const errListener = vi.fn();
        core.eventBus.on('ar:workerError', errListener);

        // @ts-ignore
        plugin._onWorkerMessage({ data: { type: 'error', payload: { message: 'boom' } } });

        expect(errListener).toHaveBeenCalledTimes(1);
        expect(errListener.mock.calls[0][0]).toEqual({ message: 'boom' });
    });

    it('sweeps markers and emits ar:markerLost when lastSeen is stale', async () => {
        const plugin = new ArtoolkitPlugin({ worker: false, lostThreshold: 1, frameDurationMs: 1 });
        await plugin.init(core);
        await plugin.enable();

        const lost = vi.fn();
        core.eventBus.on('ar:markerLost', lost);

        // Seed a marker that was seen long ago
        // @ts-ignore access internals for test
        plugin._markers.set(123, { lastSeen: Date.now() - 10, visible: true, lostCount: 0 });

        // @ts-ignore invoke internal sweep
        plugin._sweepMarkers();

        expect(lost).toHaveBeenCalledTimes(1);
        expect(lost.mock.calls[0][0].id).toBe(123);
        // marker removed
        expect(plugin.getMarkerState(123)).toBeNull();
    });

    it('posts processFrame for imageBitmap frames', async () => {
        const plugin = new ArtoolkitPlugin({ worker: false });
        await plugin.init(core);

        const postMessage = vi.fn();
        // @ts-ignore
        plugin._worker = { postMessage };

        // Simulate engine:update with an ImageBitmap-like object
        const fakeBitmap = {} as ImageBitmap;
        // @ts-ignore call private
        plugin._onEngineUpdate({ id: 1, imageBitmap: fakeBitmap, width: 100, height: 50 });

        expect(postMessage).toHaveBeenCalledTimes(1);
        const arg = postMessage.mock.calls[0][0];
        expect(arg.type).toBe('processFrame');
        expect(arg.payload.width).toBe(100);
        expect(arg.payload.height).toBe(50);
    });

    it('rejects loadMarker on timeout when no worker reply', async () => {
        vi.useFakeTimers();
        const plugin = new ArtoolkitPlugin({ worker: false });
        await plugin.init(core);
        const postMessage = vi.fn();
        // @ts-ignore
        plugin._worker = { postMessage };

        const p = plugin.loadMarker('/never-responds.patt', 1);

        // advance the 10s timeout
        vi.advanceTimersByTime(10000);

        await expect(p).rejects.toThrow(/timed out/i);
        vi.useRealTimers();
    });
});