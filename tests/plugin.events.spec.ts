import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

describe("event payload contract", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  it("emits markerId, type, matrix, confidence and timestamp", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    core.eventBus.on("ar:markerFound", found);

    const matrixGL = new Float32Array(16).fill(2);
    // @ts-ignore
    plugin._onWorkerMessage({
      data: {
        type: "detectionResult",
        payload: {
          frameId: 1,
          detected: [{ id: 5, type: "pattern", confidence: 0.77, matrixGL }],
          lost: [],
        },
      },
    });

    const payload = found.mock.calls[0][0];
    expect(payload.markerId).toBe(5);
    expect(payload.type).toBe("pattern");
    expect(payload.confidence).toBeCloseTo(0.77);
    expect(payload.matrix).toBeInstanceOf(Float32Array);
    expect(payload.matrix).toHaveLength(16);
    expect(typeof payload.timestamp).toBe("number");

    // The old names are gone, not merely deprecated.
    expect(payload.id).toBeUndefined();
    expect(payload.poseMatrix).toBeUndefined();
    expect(payload.corners).toBeUndefined();

    await plugin.disable();
  });

  it("never emits ar:getMarker", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const getMarker = vi.fn();
    core.eventBus.on("ar:getMarker", getMarker);

    // @ts-ignore  a getMarker message must not be translated into an event
    plugin._onWorkerMessage({
      data: { type: "getMarker", payload: { marker: { idPatt: 1 } } },
    });

    expect(getMarker).not.toHaveBeenCalled();

    await plugin.disable();
  });
});
