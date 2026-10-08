import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

/** Build a detectionResult message as the worker would send it. */
function detectionResult(detected: unknown[], lost: unknown[] = []) {
  return {
    data: { type: "detectionResult", payload: { frameId: 1, detected, lost } },
  };
}

describe("marker families are tracked independently", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  it("treats pattern 3 and barcode 3 as different markers", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    core.eventBus.on("ar:markerFound", found);

    // @ts-ignore private handler driven directly, as the other specs do
    plugin._onWorkerMessage(
      detectionResult([
        {
          id: 3,
          type: "pattern",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
        },
        {
          id: 3,
          type: "barcode",
          confidence: 0.8,
          matrixGL: new Float32Array(16),
        },
      ]),
    );

    expect(found).toHaveBeenCalledTimes(2);
    expect(found.mock.calls[0][0].type).toBe("pattern");
    expect(found.mock.calls[1][0].type).toBe("barcode");

    await plugin.disable();
  });

  it("losing pattern 3 accumulates misses independently of barcode 3", async () => {
    // Pattern and barcode share the numeric id 3 here on purpose: if the
    // registry were keyed by bare id instead of `${type}:${id}`, missing
    // pattern:3 would also perturb barcode:3's count.
    const plugin = new ArtoolkitPlugin({ worker: false, lostThreshold: 3 });
    await plugin.init(core);
    await plugin.enable();

    // @ts-ignore
    plugin._onWorkerMessage(
      detectionResult([
        {
          id: 3,
          type: "pattern",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
        },
        {
          id: 3,
          type: "barcode",
          confidence: 0.8,
          matrixGL: new Float32Array(16),
        },
      ]),
    );

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    const barcode3 = {
      id: 3,
      type: "barcode",
      confidence: 0.8,
      matrixGL: new Float32Array(16),
    };

    // Pattern:3 absent, barcode:3 still seen: pattern 1/3, barcode stays 0.
    // @ts-ignore
    plugin._onWorkerMessage(
      detectionResult([barcode3], [{ id: 3, type: "pattern" }]),
    );
    expect(plugin.getMarkerState(3, "pattern").consecutiveMisses).toBe(1);
    expect(plugin.getMarkerState(3, "barcode").consecutiveMisses).toBe(0);

    // Both absent (pattern 2/3, barcode 1/3) - different counts on the same
    // numeric id. The library reports barcode:3 lost here, once.
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 3, type: "barcode" }]));
    expect(lost).not.toHaveBeenCalled();

    // Both absent again, with no lost report at all: pattern:3's 3rd
    // consecutive miss crosses lostThreshold, barcode:3 (2/3) stays tracked.
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([]));

    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0][0]).toMatchObject({
      markerId: 3,
      type: "pattern",
    });
    expect(plugin.getMarkerState(3, "pattern")).toBeNull();
    const barcodeState = plugin.getMarkerState(3, "barcode");
    expect(barcodeState).not.toBeNull();
    expect(barcodeState.consecutiveMisses).toBe(2);

    // Barcode:3 crosses its own threshold on the next empty frame.
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([]));

    expect(lost).toHaveBeenCalledTimes(2);
    expect(lost.mock.calls[1][0]).toMatchObject({
      markerId: 3,
      type: "barcode",
    });
    expect(plugin.getMarkerState(3, "barcode")).toBeNull();

    await plugin.disable();
  });

  it("emits markerUpdated on the second sighting of the same marker", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    const updated = vi.fn();
    core.eventBus.on("ar:markerFound", found);
    core.eventBus.on("ar:markerUpdated", updated);

    const pose = {
      id: 1,
      type: "pattern",
      confidence: 0.9,
      matrixGL: new Float32Array(16),
    };
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose]));
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose]));

    expect(found).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);

    await plugin.disable();
  });

  it("ignores a lost report for a marker it never saw", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 99, type: "pattern" }]));

    expect(lost).not.toHaveBeenCalled();

    await plugin.disable();
  });

  it("treats pattern 0 and barcode 0 as different markers", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    core.eventBus.on("ar:markerFound", found);

    // @ts-ignore
    plugin._onWorkerMessage(
      detectionResult([
        {
          id: 0,
          type: "pattern",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
        },
        {
          id: 0,
          type: "barcode",
          confidence: 0.8,
          matrixGL: new Float32Array(16),
        },
      ]),
    );

    expect(found).toHaveBeenCalledTimes(2);
    expect(found.mock.calls[0][0].markerId).toBe(0);
    expect(found.mock.calls[1][0].markerId).toBe(0);
    expect(found.mock.calls[0][0].type).toBe("pattern");
    expect(found.mock.calls[1][0].type).toBe("barcode");

    expect(plugin.getMarkerState(0, "pattern")).not.toBeNull();
    expect(plugin.getMarkerState(0, "barcode")).not.toBeNull();

    await plugin.disable();
  });
});
