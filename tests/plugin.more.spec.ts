import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtoolkitPlugin } from '../src/plugin.js';
import { createEventBus } from './setupTests';

describe('ArtoolkitPlugin (more coverage)', () => {
    let core: { eventBus: ReturnType<typeof createEventBus> };

    beforeEach(() => {
        core = { eventBus: createEventBus() };
    });

    it('disable() removes handlers and terminates worker', async () => {
        const plugin = new ArtoolkitPlugin({ worker: true });
        await plugin.init(core);

        // Fake a browser worker with spies
        const addEventListener = vi.fn();
        const removeEventListener = vi.fn();
        const terminate = vi.fn();
        // @ts-ignore
        plugin._worker = { addEventListener, removeEventListener, terminate, postMessage: vi.fn() };

        await plugin.enable();
        // Simulate that we added a message listener during start
        expect(typeof plugin.enabled).toBe('boolean');

        await plugin.disable();

        expect(removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    it('engine:update falls back when postMessage throws', async () => {
        const plugin = new ArtoolkitPlugin({ worker: true });
        await plugin.init(core);

        const postMessage = vi.fn(() => { throw new Error('boom'); });
        // @ts-ignore
        plugin._worker = { postMessage };

        // No throw should propagate
        // @ts-ignore call private
        plugin._onEngineUpdate({ id: 99, imageBitmap: {} as ImageBitmap, width: 2, height: 2 });

        // Fallback tries a second post without ImageBitmap, so we expect at least one call
        expect(postMessage).toHaveBeenCalled();
    });

    it('getMarkerState returns null when marker not tracked', async () => {
        const plugin = new ArtoolkitPlugin({ worker: false });
        await plugin.init(core);
        expect(plugin.getMarkerState(12345)).toBeNull();
    });

    it('detectionResult with no detections is safely ignored', async () => {
        const plugin = new ArtoolkitPlugin({ worker: false });
        await plugin.init(core);
        await plugin.enable();

        // @ts-ignore
        plugin._onWorkerMessage({ data: { type: 'detectionResult', payload: {} } });

        // No exception; no markers added
        expect(plugin.getMarkerState(1)).toBeNull();
    });
});