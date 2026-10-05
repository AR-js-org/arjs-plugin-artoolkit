import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

describe("ArtoolkitPlugin (more coverage)", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  it("disable() removes handlers and terminates worker", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);

    // Fake a browser worker with spies. postMessage/terminate record into a
    // shared sequence so the dispose-before-terminate ordering can be pinned.
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const calls: string[] = [];
    const postMessage = vi.fn((msg: any) => {
      if (msg?.type === "dispose") calls.push("dispose");
    });
    const terminate = vi.fn(() => {
      calls.push("terminate");
    });
    // @ts-ignore
    plugin._worker = {
      addEventListener,
      removeEventListener,
      terminate,
      postMessage,
    };

    await plugin.enable();
    // Simulate that we added a message listener during start
    expect(typeof plugin.enabled).toBe("boolean");

    await plugin.disable();

    expect(removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );

    // Termination is deferred so the worker can process the dispose message.
    expect(terminate).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["dispose", "terminate"]);
  });

  it("engine:update falls back when postMessage throws", async () => {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);

    const postMessage = vi.fn(() => {
      throw new Error("boom");
    });
    // @ts-ignore
    plugin._worker = { postMessage };

    // No throw should propagate
    // @ts-ignore call private
    plugin._onEngineUpdate({
      id: 99,
      imageBitmap: {} as ImageBitmap,
      width: 2,
      height: 2,
    });

    // The first call sends the ImageBitmap payload and throws; the catch
    // block's fallback sends a second, lighter payload without ImageBitmap.
    // That fallback call also throws here (the stub throws unconditionally),
    // but that second throw is itself caught and swallowed. Pinning the call
    // count to 2 confirms the fallback attempt actually happens, not just
    // that postMessage was called at all.
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("getMarkerState returns null when marker not tracked", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    expect(plugin.getMarkerState(12345, "pattern")).toBeNull();
  });

  it("detectionResult with no detections is safely ignored", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    // @ts-ignore
    plugin._onWorkerMessage({ data: { type: "detectionResult", payload: {} } });

    // No exception; no markers added
    expect(plugin.getMarkerState(1, "pattern")).toBeNull();
  });
});
