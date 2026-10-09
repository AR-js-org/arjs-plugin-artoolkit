import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

/**
 * Backpressure between the plugin and the detection worker.
 *
 * `_onEngineUpdate` used to post one `processFrame` per `engine:update` with
 * no regard for whether the worker had finished the previous one. The worker
 * only ever replied when it had something to report, so once `detect()` took
 * longer than the frame interval - which real pattern matching at 60fps does
 * - postMessage's unbounded FIFO queue grew without bound and every later
 * message, including `loadMarker`, waited behind the backlog. See the
 * "Post-implementation note" appended to the worker message protocol section
 * of docs/superpowers/specs/2026-09-17-artoolkit5-ts-migration-design.md.
 *
 * The fix is an in-flight flag: at most one frame is ever posted to the
 * worker at a time. These tests drive that flag through the same private
 * entry points the rest of the suite uses (`_onEngineUpdate`,
 * `_onWorkerMessage`, `_stopWorker`) against a stub worker object, per the
 * conventions in tests/plugin.more.spec.ts.
 */
describe("ArtoolkitPlugin frame backpressure", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  /** A bitmap-like stub whose close() we can assert on. */
  function fakeBitmap() {
    return { close: vi.fn() } as unknown as ImageBitmap;
  }

  it("drops a second frame that arrives while the first is still in flight, and closes its bitmap", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);

    const postMessage = vi.fn();
    // @ts-ignore private field, stubbed as other specs do
    plugin._worker = { postMessage };

    const firstBitmap = fakeBitmap();
    // @ts-ignore call private
    plugin._onEngineUpdate({
      id: 1,
      imageBitmap: firstBitmap,
      width: 100,
      height: 50,
    });

    expect(postMessage).toHaveBeenCalledTimes(1);

    // Second frame arrives before the worker has acknowledged the first.
    const secondBitmap = fakeBitmap();
    // @ts-ignore
    plugin._onEngineUpdate({
      id: 2,
      imageBitmap: secondBitmap,
      width: 100,
      height: 50,
    });

    // Dropped, not queued: no second postMessage call.
    expect(postMessage).toHaveBeenCalledTimes(1);
    // The dropped bitmap must be closed or it leaks a full-resolution frame.
    expect(secondBitmap.close).toHaveBeenCalledTimes(1);
    // The in-flight frame's bitmap was transferred, not dropped; leave it alone.
    expect(firstBitmap.close).not.toHaveBeenCalled();
  });

  it("posts again once a detectionResult acknowledges the in-flight frame", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);

    const postMessage = vi.fn();
    // @ts-ignore
    plugin._worker = { postMessage };

    // @ts-ignore
    plugin._onEngineUpdate({
      id: 1,
      imageBitmap: fakeBitmap(),
      width: 100,
      height: 50,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);

    // Worker acknowledges frame 1 - nothing detected, but that still counts.
    // @ts-ignore
    plugin._onWorkerMessage({
      data: {
        type: "detectionResult",
        payload: { frameId: 1, detected: [], lost: [] },
      },
    });

    const secondBitmap = fakeBitmap();
    // @ts-ignore
    plugin._onEngineUpdate({
      id: 2,
      imageBitmap: secondBitmap,
      width: 100,
      height: 50,
    });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(secondBitmap.close).not.toHaveBeenCalled();
  });

  it("recovers frame submission after a worker error, instead of wedging permanently", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);

    const postMessage = vi.fn();
    // @ts-ignore
    plugin._worker = { postMessage };

    // @ts-ignore
    plugin._onEngineUpdate({
      id: 1,
      imageBitmap: fakeBitmap(),
      width: 100,
      height: 50,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);

    // The worker reports an error instead of a detectionResult for frame 1.
    // @ts-ignore
    plugin._onWorkerMessage({
      data: { type: "error", payload: { message: "boom" } },
    });

    const secondBitmap = fakeBitmap();
    // @ts-ignore
    plugin._onEngineUpdate({
      id: 2,
      imageBitmap: secondBitmap,
      width: 100,
      height: 50,
    });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(secondBitmap.close).not.toHaveBeenCalled();
  });

  it("still posts a frame with no ImageBitmap when nothing is in flight (pre-existing path, unchanged)", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);

    const postMessage = vi.fn();
    // @ts-ignore
    plugin._worker = { postMessage };

    // No imageBitmap at all - the "lighter payload" fallback path.
    // @ts-ignore call private
    plugin._onEngineUpdate({ id: 1, width: 100, height: 50 });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const arg = postMessage.mock.calls[0][0];
    expect(arg.type).toBe("processFrame");
    // Unchanged pre-existing shape: no width/height on this fallback payload.
    expect(arg.payload).toEqual({ frameId: 1 });
  });

  it("gates a no-ImageBitmap frame the same as any other while one is in flight", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);

    const postMessage = vi.fn();
    // @ts-ignore
    plugin._worker = { postMessage };

    // First frame has no bitmap, but still counts as "in flight" - the
    // worker acknowledges it too (see src/worker/worker.js's early return).
    // @ts-ignore
    plugin._onEngineUpdate({ id: 1, width: 100, height: 50 });
    expect(postMessage).toHaveBeenCalledTimes(1);

    const secondBitmap = fakeBitmap();
    // @ts-ignore
    plugin._onEngineUpdate({
      id: 2,
      imageBitmap: secondBitmap,
      width: 100,
      height: 50,
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(secondBitmap.close).toHaveBeenCalledTimes(1);
  });

  it("resets the in-flight flag in _stopWorker, so a restarted worker is not born blocked", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);

    const worker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      terminate: vi.fn(),
    };
    // @ts-ignore
    plugin._worker = worker;

    // @ts-ignore
    plugin._onEngineUpdate({
      id: 1,
      imageBitmap: fakeBitmap(),
      width: 10,
      height: 10,
    });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    // The worker is torn down before it ever acknowledges frame 1.
    // @ts-ignore private method, exercised directly as other specs do
    plugin._stopWorker();

    // A fresh worker after restart.
    const restarted = { postMessage: vi.fn() };
    // @ts-ignore
    plugin._worker = restarted;

    const secondBitmap = fakeBitmap();
    // @ts-ignore
    plugin._onEngineUpdate({
      id: 2,
      imageBitmap: secondBitmap,
      width: 10,
      height: 10,
    });

    expect(restarted.postMessage).toHaveBeenCalledTimes(1);
    expect(secondBitmap.close).not.toHaveBeenCalled();
  });
});

describe("ar:camera and the frame slot", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  const camera = {
    data: {
      type: "camera",
      payload: {
        projectionMatrix: Array.from({ length: 16 }, (_, i) => i),
        width: 640,
        height: 480,
      },
    },
  };

  it("a camera message does not release the frame in flight", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);
    // @ts-ignore private field, stubbed as the tests above do
    plugin._worker = { postMessage: vi.fn() };
    // @ts-ignore
    plugin._frameInFlight = true;

    // @ts-ignore call private
    plugin._onWorkerMessage(camera);

    // @ts-ignore
    expect(plugin._frameInFlight).toBe(true);
  });

  it("getProjectionMatrix is null again once the worker stops", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);
    const worker = {
      postMessage: vi.fn(),
      removeEventListener: vi.fn(),
      terminate: vi.fn(),
    };
    // @ts-ignore private field
    plugin._worker = worker;
    // @ts-ignore call private
    plugin._onWorkerMessage(camera);
    expect(plugin.getProjectionMatrix()).not.toBeNull();

    // @ts-ignore call private
    plugin._stopWorker();

    expect(plugin.getProjectionMatrix()).toBeNull();
  });
});
