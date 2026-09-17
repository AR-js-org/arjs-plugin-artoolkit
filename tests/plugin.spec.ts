import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

describe("ArtoolkitPlugin", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  it("initializes and enables without starting a real Worker", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();
    expect(plugin.enabled).toBe(true);

    await plugin.disable();
    expect(plugin.enabled).toBe(false);
  });

  it("emits markerFound then markerUpdated on detectionResult payloads", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    const updated = vi.fn();
    core.eventBus.on("ar:markerFound", found);
    core.eventBus.on("ar:markerUpdated", updated);

    // Simulate first detection of id=1
    // @ts-ignore private method used intentionally for test
    plugin._onWorkerMessage({
      data: {
        type: "detectionResult",
        payload: {
          frameId: 1,
          detected: [
            {
              id: 1,
              type: "pattern",
              confidence: 0.92,
              matrixGL: new Float32Array(16),
            },
          ],
          lost: [],
        },
      },
    });

    // Simulate an update for the same marker
    // @ts-ignore
    plugin._onWorkerMessage({
      data: {
        type: "detectionResult",
        payload: {
          frameId: 1,
          detected: [
            {
              id: 1,
              type: "pattern",
              confidence: 0.88,
              matrixGL: new Float32Array(16),
            },
          ],
          lost: [],
        },
      },
    });

    expect(found).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
    // Optional shape assertions
    const first = found.mock.calls[0][0];
    expect(first.markerId).toBe(1);
    expect(first.matrix).toBeInstanceOf(Float32Array);
    expect(first.matrix.length).toBe(16);
  });

  it("resolves loadMarker promises when worker replies", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);

    // Attach a stub worker so loadMarker can postMessage
    const postMessage = vi.fn();
    // @ts-ignore
    plugin._worker = { postMessage };

    const p = plugin.loadMarker("/pattern.patt", 1);

    // Simulate worker response with requestId=0 (first call)
    // @ts-ignore
    plugin._onWorkerMessage({
      data: {
        type: "loadMarkerResult",
        payload: { ok: true, markerId: 42, size: 1, requestId: 0 },
      },
    });

    await expect(p).resolves.toEqual({ markerId: 42, size: 1 });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("emits ar:workerReady on ready message", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);

    const ready = vi.fn();
    core.eventBus.on("ar:workerReady", ready);

    // @ts-ignore
    plugin._onWorkerMessage({ data: { type: "ready", payload: {} } });

    expect(ready).toHaveBeenCalledTimes(1);
  });
});
