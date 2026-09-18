import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

/**
 * Debounce on the library-reported lost path.
 *
 * The artoolkit5-ts migration made `_applyLost` emit `ar:markerLost` on the
 * first frame the detector reported a marker missing, with no debounce at
 * all. ARToolKit routinely fails to detect a well-tracked marker on an
 * individual frame - angle, motion blur, lighting - so this produced
 * constant FOUND -> UPDATED -> LOST -> FOUND churn even for strong
 * detections, observed on real hardware at confidence 0.86-0.88.
 *
 * Pre-migration (see `git show 9de4b46:src/plugin.js`) there was no
 * library-lost path at all: `ar:markerLost` came solely from the interval
 * sweep, so a marker had to go `lostThreshold * frameDurationMs` without a
 * detection before LOST fired. These tests pin the replacement: a
 * consecutive-miss counter on each registry entry, reset by any detection,
 * that must reach `lostThreshold` before `ar:markerLost` fires. See the
 * "Post-implementation note" appended to the Event contract section of
 * docs/superpowers/specs/2026-09-17-artoolkit5-ts-migration-design.md.
 *
 * `_sweepMarkers` (the stall guard for frames that stop arriving entirely)
 * is untouched and is not exercised here; see tests/plugin.stall.spec.ts.
 */
describe("lost-marker debounce", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  /** Build a detectionResult message as the worker would send it. */
  function detectionResult(detected: unknown[], lost: unknown[] = []) {
    return {
      data: {
        type: "detectionResult",
        payload: { frameId: 1, detected, lost },
      },
    };
  }

  /** Build a detected pose for `id`/`type`. */
  function pose(id: number, type: string, confidence = 0.9) {
    return { id, type, confidence, matrixGL: new Float32Array(16) };
  }

  it("a single missed frame emits nothing and leaves the marker tracked", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const lost = vi.fn();
    const updated = vi.fn();
    core.eventBus.on("ar:markerLost", lost);
    core.eventBus.on("ar:markerUpdated", updated);

    // @ts-ignore private handler driven directly, as the other specs do
    plugin._onWorkerMessage(detectionResult([pose(1, "pattern")]));
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 1, type: "pattern" }]));

    expect(lost).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();

    const state = plugin.getMarkerState(1, "pattern");
    expect(state).not.toBeNull();
    expect(state.consecutiveMisses).toBe(1);

    await plugin.disable();
  });

  it("lostThreshold consecutive misses emits exactly one ar:markerLost", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false, lostThreshold: 5 });
    await plugin.init(core);
    await plugin.enable();

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose(7, "barcode")]));
    for (let i = 0; i < 5; i++) {
      // @ts-ignore
      plugin._onWorkerMessage(
        detectionResult([], [{ id: 7, type: "barcode" }]),
      );
    }

    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0][0]).toMatchObject({
      markerId: 7,
      type: "barcode",
    });
    expect(plugin.getMarkerState(7, "barcode")).toBeNull();

    await plugin.disable();
  });

  it("a detection partway through the miss run resets the counter", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false, lostThreshold: 3 });
    await plugin.init(core);
    await plugin.enable();

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose(2, "pattern")]));
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 2, type: "pattern" }])); // 1/3
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 2, type: "pattern" }])); // 2/3
    expect(plugin.getMarkerState(2, "pattern").consecutiveMisses).toBe(2);

    // A good frame partway through must fully clear the count, not just
    // decrement it.
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose(2, "pattern")]));
    expect(plugin.getMarkerState(2, "pattern").consecutiveMisses).toBe(0);

    // Two more misses post-reset: 2 (pre-reset) + 2 (post-reset) = 4, which
    // would already be >= lostThreshold(3) under a naive cumulative counter.
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 2, type: "pattern" }])); // 1/3 since reset
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 2, type: "pattern" }])); // 2/3 since reset
    expect(lost).not.toHaveBeenCalled();

    // Third consecutive miss since the reset: now it crosses the threshold.
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 2, type: "pattern" }])); // 3/3 since reset
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0][0]).toMatchObject({
      markerId: 2,
      type: "pattern",
    });

    await plugin.disable();
  });

  it("re-detection while within tolerance emits ar:markerUpdated, not ar:markerFound", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false, lostThreshold: 5 });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    const updated = vi.fn();
    core.eventBus.on("ar:markerFound", found);
    core.eventBus.on("ar:markerUpdated", updated);

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose(4, "pattern")])); // found
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 4, type: "pattern" }])); // miss, still within tolerance
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose(4, "pattern")])); // re-detected

    expect(found).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(plugin.getMarkerState(4, "pattern").consecutiveMisses).toBe(0);

    await plugin.disable();
  });

  it("after ar:markerLost fires, a later detection emits ar:markerFound again", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false, lostThreshold: 2 });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    const lost = vi.fn();
    core.eventBus.on("ar:markerFound", found);
    core.eventBus.on("ar:markerLost", lost);

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose(9, "barcode")])); // found #1
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 9, type: "barcode" }])); // 1/2
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 9, type: "barcode" }])); // 2/2 -> lost

    expect(lost).toHaveBeenCalledTimes(1);
    expect(plugin.getMarkerState(9, "barcode")).toBeNull();

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose(9, "barcode")])); // found #2

    expect(found).toHaveBeenCalledTimes(2);

    await plugin.disable();
  });

  it("a non-default lostThreshold is respected", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false, lostThreshold: 2 });
    await plugin.init(core);
    await plugin.enable();

    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([pose(5, "pattern")]));
    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 5, type: "pattern" }])); // 1/2
    expect(lost).not.toHaveBeenCalled();

    // @ts-ignore
    plugin._onWorkerMessage(detectionResult([], [{ id: 5, type: "pattern" }])); // 2/2
    expect(lost).toHaveBeenCalledTimes(1);

    await plugin.disable();
  });
});
