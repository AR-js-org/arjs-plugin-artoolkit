import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

/**
 * Plugin side of barcode tracking, runtime configuration, and the fixes that
 * shipped with them (#28, #38, #40). The worker is a stub whose postMessage
 * records requests; replies are fed back through `_onWorkerMessage`, as the
 * worker would send them.
 */
describe("barcode tracking and detector configuration", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };
  let plugin: ArtoolkitPlugin;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    core = { eventBus: createEventBus() };
    plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    postMessage = vi.fn();
    // @ts-ignore inject a stub worker
    plugin._worker = { postMessage };
  });

  /** Reply to the most recent request the plugin posted. */
  function reply(type: string, payload: Record<string, unknown>) {
    const { requestId } = postMessage.mock.calls.at(-1)[0].payload;
    // @ts-ignore private handler
    plugin._onWorkerMessage({
      data: { type, payload: { ...payload, requestId } },
    });
  }

  it("trackBarcode posts a request and resolves with the worker's result", async () => {
    const pending = plugin.trackBarcode(5, 2);

    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type: "trackBarcode",
      payload: { barcodeId: 5, size: 2 },
    });
    reply("trackBarcodeResult", {
      ok: true,
      markerId: 5,
      size: 2,
      detectionMode: "color_and_matrix",
    });

    await expect(pending).resolves.toEqual({
      markerId: 5,
      size: 2,
      detectionMode: "color_and_matrix",
    });
  });

  it("trackBarcode rejects with the worker's error", async () => {
    const pending = plugin.trackBarcode(-1);
    reply("trackBarcodeResult", { ok: false, error: "Invalid barcodeId: -1" });
    await expect(pending).rejects.toThrow("Invalid barcodeId: -1");
  });

  it("configureDetector posts the partial options and resolves with the config", async () => {
    const pending = plugin.configureDetector({ thresholdMode: "auto_otsu" });

    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type: "configure",
      payload: { opts: { thresholdMode: "auto_otsu" } },
    });
    reply("configureResult", {
      ok: true,
      config: { thresholdMode: "auto_otsu" },
    });

    await expect(pending).resolves.toEqual({
      config: { thresholdMode: "auto_otsu" },
    });
  });

  it("both reject without a worker", async () => {
    // @ts-ignore
    plugin._worker = null;
    await expect(plugin.trackBarcode(1)).rejects.toThrow(
      "Worker not available",
    );
    await expect(plugin.configureDetector({})).rejects.toThrow(
      "Worker not available",
    );
  });

  it("stopping the worker rejects requests still waiting on it at once", async () => {
    // @ts-ignore extend the stub so _stopWorker can tear it down
    Object.assign(plugin._worker, {
      removeEventListener: vi.fn(),
      terminate: vi.fn(),
    });
    const barcode = plugin.trackBarcode(1);
    const config = plugin.configureDetector({ threshold: 90 });
    const marker = plugin.loadMarker("/patt.hiro", 1);

    // @ts-ignore private
    plugin._stopWorker();

    await expect(barcode).rejects.toThrow("Worker stopped");
    await expect(config).rejects.toThrow("Worker stopped");
    await expect(marker).rejects.toThrow("Worker stopped");
    // @ts-ignore private
    expect(plugin._pendingMarkerLoads.size).toBe(0);
  });

  it("loadMarker still resolves with { markerId, size } through the shared request path", async () => {
    const pending = plugin.loadMarker("/patt.hiro", 1);
    reply("loadMarkerResult", { ok: true, markerId: 0, size: 1 });
    await expect(pending).resolves.toEqual({ markerId: 0, size: 1 });
  });

  it("emits ar:workerError on initError without releasing the frame in flight (#40)", () => {
    const err = vi.fn();
    core.eventBus.on("ar:workerError", err);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // @ts-ignore
    plugin._frameInFlight = true;

    // @ts-ignore
    plugin._onWorkerMessage({
      data: { type: "initError", payload: { message: "404 wasm" } },
    });

    expect(err).toHaveBeenCalledWith({ message: "404 wasm" });
    // @ts-ignore
    expect(plugin._frameInFlight).toBe(true);
  });
});

describe("init payload", () => {
  it("sends detector options without unset keys", () => {
    const plugin = new ArtoolkitPlugin({
      detectionMode: "color_and_matrix",
      matrixCodeType: "4x4",
      detector: { threshold: 100 },
    });
    // @ts-ignore private
    expect(plugin._detectorOptions()).toEqual({
      threshold: 100,
      detectionMode: "color_and_matrix",
      matrixCodeType: "4x4",
    });
    // @ts-ignore private
    expect(new ArtoolkitPlugin()._detectorOptions()).toEqual({});
  });

  it("keeps detectionMode and matrixCodeType given through `detector`", () => {
    const plugin = new ArtoolkitPlugin({
      detector: { detectionMode: "mono_and_matrix", matrixCodeType: "4x4" },
    });
    // @ts-ignore private
    expect(plugin._detectorOptions()).toEqual({
      detectionMode: "mono_and_matrix",
      matrixCodeType: "4x4",
    });
  });

  it("lets the top-level options win over the same keys in `detector`", () => {
    const plugin = new ArtoolkitPlugin({
      detectionMode: "matrix",
      detector: { detectionMode: "mono", matrixCodeType: "4x4" },
    });
    // @ts-ignore private
    expect(plugin._detectorOptions()).toEqual({
      detectionMode: "matrix",
      matrixCodeType: "4x4",
    });
  });
});

describe("loss is counted per processed frame (#38)", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    vi.useFakeTimers();
    core = { eventBus: createEventBus() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function frame(detected: unknown[], lost: unknown[] = []) {
    return { data: { type: "detectionResult", payload: { detected, lost } } };
  }
  const pose = {
    id: 1,
    type: "pattern",
    confidence: 0.9,
    matrixGL: new Float32Array(16),
  };

  it("one library lost report followed by empty frames fires on the lostThreshold-th frame", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false, lostThreshold: 5 });
    await plugin.init(core);
    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // @ts-ignore
    plugin._onWorkerMessage(frame([pose]));
    // artoolkit5-ts reports the loss exactly once...
    // @ts-ignore
    plugin._onWorkerMessage(frame([], [{ id: 1, type: "pattern" }]));
    // ...and never again on the following frames.
    for (let i = 0; i < 3; i++) {
      // @ts-ignore
      plugin._onWorkerMessage(frame([]));
    }
    expect(lost).not.toHaveBeenCalled();

    // @ts-ignore
    plugin._onWorkerMessage(frame([]));
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0][0]).toMatchObject({
      markerId: 1,
      type: "pattern",
    });
  });

  it("slow but live frames do not trip the stall guard before lostThreshold misses", async () => {
    const plugin = new ArtoolkitPlugin({
      worker: false,
      lostThreshold: 3,
      frameDurationMs: 100,
      sweepIntervalMs: 50,
    });
    await plugin.init(core);
    await plugin.enable();
    const lost = vi.fn();
    core.eventBus.on("ar:markerLost", lost);

    // @ts-ignore
    plugin._onWorkerMessage(frame([pose]));
    // Frames every 250ms: slower than frameDurationMs, but each one arrives
    // inside the 300ms stall window.
    vi.advanceTimersByTime(250);
    // @ts-ignore
    plugin._onWorkerMessage(frame([]));
    vi.advanceTimersByTime(250);
    // @ts-ignore
    plugin._onWorkerMessage(frame([]));
    expect(lost).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    // @ts-ignore
    plugin._onWorkerMessage(frame([]));
    expect(lost).toHaveBeenCalledTimes(1);

    await plugin.disable();
  });
});

describe("ImageBitmap release (#28)", () => {
  it("closes the bitmap when there is no worker", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init({ eventBus: createEventBus() });
    const close = vi.fn();

    // @ts-ignore private
    plugin._onEngineUpdate({
      id: 1,
      imageBitmap: { close },
      width: 1,
      height: 1,
    });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the bitmap when the transfer throws", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init({ eventBus: createEventBus() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const postMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("DataCloneError");
      })
      .mockImplementation(() => {});
    // @ts-ignore
    plugin._worker = { postMessage };
    const close = vi.fn();

    // @ts-ignore private
    plugin._onEngineUpdate({
      id: 1,
      imageBitmap: { close },
      width: 1,
      height: 1,
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
