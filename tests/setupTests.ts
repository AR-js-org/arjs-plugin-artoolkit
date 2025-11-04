// Basic jsdom setup and minimal Worker mock (only if needed in other tests).
// These tests avoid creating a real Worker; we test plugin logic by simulating messages.

class MockWorker {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {}
}
// Only define if not present, to avoid clobbering if jsdom/vitest adds one later
if (typeof globalThis.Worker === 'undefined') {
    // @ts-ignore
    globalThis.Worker = MockWorker as any;
}

// Tiny event bus used by tests (mimics the plugin's expected interface)
export function createEventBus() {
    const map = new Map<string, Function[]>();
    return {
        on(e: string, fn: Function) {
            if (!map.has(e)) map.set(e, []);
            map.get(e)!.push(fn);
        },
        off(e: string, fn: Function) {
            if (!map.has(e)) return;
            map.set(e, map.get(e)!.filter((x) => x !== fn));
        },
        emit(e: string, payload?: any) {
            (map.get(e) || []).forEach((fn) => fn(payload));
        }
    };
}