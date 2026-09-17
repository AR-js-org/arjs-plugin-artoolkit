import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

describe("staleness guard", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    vi.useFakeTimers();
    core = { eventBus: createEventBus() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits markerLost when frames stop arriving", async () => {
    const plugin = new ArtoolkitPlugin({
      worker: false,
      lostThreshold: 2,
      frameDurationMs: 100,
      sweepIntervalMs: 50,
    });
    await plugin.init(core);
    await plugin.enable();

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
              confidence: 0.9,
              matrixGL: new Float32Array(16),
            },
          ],
          lost: [],
        },
      },
    });

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // No further frames: lostThreshold * frameDurationMs = 200ms
    vi.advanceTimersByTime(400);

    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0][0]).toMatchObject({
      markerId: 1,
      type: "pattern",
    });

    await plugin.disable();
  });

  it("does not sweep a marker that keeps being detected", async () => {
    const plugin = new ArtoolkitPlugin({
      worker: false,
      lostThreshold: 2,
      frameDurationMs: 100,
      sweepIntervalMs: 50,
    });
    await plugin.init(core);
    await plugin.enable();

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    const pose = {
      id: 1,
      type: "pattern",
      confidence: 0.9,
      matrixGL: new Float32Array(16),
    };
    for (let i = 0; i < 6; i++) {
      // @ts-ignore
      plugin._onWorkerMessage({
        data: {
          type: "detectionResult",
          payload: { frameId: i, detected: [pose], lost: [] },
        },
      });
      vi.advanceTimersByTime(50);
    }

    expect(lost).not.toHaveBeenCalled();

    await plugin.disable();
  });
});
