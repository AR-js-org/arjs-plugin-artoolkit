import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { ArtoolkitPlugin } from "../src/plugin.js";
import { createEventBus } from "./setupTests";

/**
 * The worker's message protocol, driven through the real `src/worker/worker.js`
 * with the detector and the worker global scope stubbed (#29). Every other
 * spec hand-builds the worker's replies; these pin what the worker actually
 * posts, so the two cannot drift apart silently.
 */

const detector = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  loadPattern: vi.fn(),
  configure: vi.fn(),
  trackBarcode: vi.fn(),
  detect: vi.fn(),
  dispose: vi.fn(),
  getProjectionMatrix: vi.fn(),
}));
/** The options the worker built its detector with, kept across tests. */
const created = vi.hoisted(() => ({ opts: null as any }));
const createDetector = vi.hoisted(() =>
  vi.fn((opts: unknown) => {
    created.opts = opts;
    return detector;
  }),
);

vi.mock("../src/detector/artoolkit-detector.js", () => ({ createDetector }));

const posted: Array<{ type: string; payload?: Record<string, unknown> }> = [];
/** Where the worker's replies go besides `posted`; set by the round trip. */
let deliver: ((msg: never) => void) | null = null;
let onMessage: (ev: { data: unknown }) => Promise<void>;

class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    };
  }
}

beforeAll(async () => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.spyOn(self, "postMessage").mockImplementation(((msg: never) => {
    posted.push(msg);
    deliver?.(msg);
  }) as never);
  const add = vi.spyOn(self, "addEventListener");
  await import("../src/worker/worker.js");
  onMessage = add.mock.calls.find(([t]) => t === "message")![1] as never;
});

beforeEach(() => {
  posted.length = 0;
  vi.clearAllMocks();
  detector.ensureReady.mockResolvedValue(true);
  detector.detect.mockReturnValue({ detected: [], lost: [] });
  detector.getProjectionMatrix.mockReturnValue(
    Float64Array.from({ length: 16 }, (_, i) => i + 1),
  );
});

async function send(type: string, payload?: Record<string, unknown>) {
  await onMessage({ data: { type, payload } });
  return posted.at(-1);
}

describe("worker message protocol", () => {
  it("init builds the detector once with options, and reports init failures as initError", async () => {
    await send("init", {
      cameraParametersUrl: "/cam.dat",
      wasmUrl: "/a.wasm",
      minConfidence: 0.7,
      detectorOptions: { detectionMode: "color_and_matrix" },
    });
    await send("init", {});

    expect(createDetector).toHaveBeenCalledTimes(1);
    const opts = createDetector.mock.calls[0][0] as Record<string, any>;
    expect(opts).toMatchObject({
      cameraParametersUrl: "/cam.dat",
      wasmUrl: "/a.wasm",
      minConfidence: 0.7,
      detectorOptions: { detectionMode: "color_and_matrix" },
    });

    opts.onInitError(new Error("404"));
    expect(posted.at(-1)).toEqual({
      type: "initError",
      payload: { message: expect.stringContaining("404") },
    });
  });

  it("loadMarker replies with loadMarkerResult", async () => {
    detector.loadPattern.mockResolvedValue(3);
    expect(
      await send("loadMarker", {
        patternUrl: "/p.patt",
        size: 2,
        requestId: 1,
      }),
    ).toEqual({
      type: "loadMarkerResult",
      payload: { ok: true, markerId: 3, size: 2, requestId: 1 },
    });
  });

  it("trackBarcode replies with the detector's result", async () => {
    detector.trackBarcode.mockResolvedValue({
      markerId: 5,
      size: 1,
      detectionMode: "color_and_matrix",
    });
    expect(await send("trackBarcode", { barcodeId: 5, requestId: 2 })).toEqual({
      type: "trackBarcodeResult",
      payload: {
        ok: true,
        markerId: 5,
        size: 1,
        detectionMode: "color_and_matrix",
        requestId: 2,
      },
    });
    expect(detector.trackBarcode).toHaveBeenCalledWith(5, 1);
  });

  it("configure replies with the config, or the error", async () => {
    detector.configure.mockResolvedValueOnce({ threshold: 90 });
    expect(
      await send("configure", { opts: { threshold: 90 }, requestId: 3 }),
    ).toEqual({
      type: "configureResult",
      payload: { ok: true, config: { threshold: 90 }, requestId: 3 },
    });

    detector.configure.mockRejectedValueOnce(new Error("bad"));
    expect(await send("configure", { opts: {}, requestId: 4 })).toEqual({
      type: "configureResult",
      payload: { ok: false, error: "bad", requestId: 4 },
    });
  });

  it("processFrame always acknowledges with detectionResult and closes the bitmap", async () => {
    const close = vi.fn();
    detector.detect.mockReturnValue({
      detected: [{ id: 0, type: "barcode" }],
      lost: [],
    });

    expect(
      await send("processFrame", {
        frameId: 9,
        imageBitmap: { close, width: 2, height: 2 },
        width: 2,
        height: 2,
      }),
    ).toEqual({
      type: "detectionResult",
      payload: { frameId: 9, detected: [{ id: 0, type: "barcode" }], lost: [] },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a frame it cannot analyse as skipped", async () => {
    expect(await send("processFrame", { frameId: 4 })).toEqual({
      type: "detectionResult",
      payload: { frameId: 4, detected: [], lost: [], skipped: true },
    });
  });

  it("sends camera once, after the first frame readies the detector", async () => {
    // A fresh detector: earlier tests may already have sent its camera.
    await send("dispose");
    await send("init", {});
    posted.length = 0;

    const frame = (frameId: number) => ({
      frameId,
      imageBitmap: { close: vi.fn(), width: 640, height: 480 },
      width: 640,
      height: 480,
    });
    await send("processFrame", frame(1));
    await send("processFrame", frame(2));

    const types = posted.map((m) => m.type);
    const cameras = posted.filter((m) => m.type === "camera");
    expect(cameras).toHaveLength(1);
    expect(types.indexOf("camera")).toBeLessThan(
      types.indexOf("detectionResult"),
    );
    expect(cameras[0].payload).toEqual({
      projectionMatrix: Array.from({ length: 16 }, (_, i) => i + 1),
      width: 640,
      height: 480,
    });
  });

  it("a skipped frame sends no camera", async () => {
    await send("dispose");
    await send("init", {});
    posted.length = 0;

    await send("processFrame", { frameId: 3 });

    expect(posted.some((m) => m.type === "camera")).toBe(false);
  });

  it("closes the bitmap and posts error when readiness throws (#28)", async () => {
    const close = vi.fn();
    detector.ensureReady.mockRejectedValue(new Error("bad option"));

    expect(
      await send("processFrame", {
        frameId: 1,
        imageBitmap: { close },
        width: 2,
        height: 2,
      }),
    ).toEqual({ type: "error", payload: { message: "bad option" } });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

/**
 * The plugin and the real worker wired back to back: the plugin's requests
 * reach the worker's listener, and what the worker posts reaches the plugin's
 * handler. The protocol tests above pin the shapes; these pin that the plugin
 * consumes them, so a change on either side cannot pass alone.
 */
describe("plugin ↔ worker round trip", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };
  let plugin: ArtoolkitPlugin;

  beforeEach(async () => {
    core = { eventBus: createEventBus() };
    plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    // @ts-ignore stand in for the Worker object
    plugin._worker = {
      postMessage: (msg: unknown) => void onMessage({ data: msg }),
    };
    // @ts-ignore private handler
    deliver = (msg) => plugin._onWorkerMessage({ data: msg });
    await onMessage({ data: { type: "init", payload: {} } });
  });

  afterEach(() => {
    deliver = null;
  });

  it("loadMarker resolves with the worker's reply", async () => {
    detector.loadPattern.mockResolvedValue(3);
    await expect(plugin.loadMarker("/p.patt", 2)).resolves.toEqual({
      markerId: 3,
      size: 2,
    });
  });

  it("trackBarcode resolves with the detector's result", async () => {
    detector.trackBarcode.mockResolvedValue({
      markerId: 5,
      size: 1,
      detectionMode: "color_and_matrix",
    });
    await expect(plugin.trackBarcode(5)).resolves.toEqual({
      markerId: 5,
      size: 1,
      detectionMode: "color_and_matrix",
    });
  });

  it("configureDetector rejects with the option the detector refused", async () => {
    detector.configure.mockRejectedValue(new Error("bad threshold"));
    await expect(plugin.configureDetector({ threshold: -1 })).rejects.toThrow(
      "bad threshold",
    );
  });

  it("a detection becomes ar:markerFound and releases the frame in flight", async () => {
    const found = vi.fn();
    core.eventBus.on("ar:markerFound", found);
    const vertex = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    detector.detect.mockReturnValue({
      detected: [
        {
          id: 0,
          type: "barcode",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
          vertex,
          dir: 2,
        },
      ],
      lost: [],
    });
    // @ts-ignore private
    plugin._frameInFlight = true;

    await onMessage({
      data: {
        type: "processFrame",
        payload: {
          frameId: 1,
          imageBitmap: { close() {} },
          width: 2,
          height: 2,
        },
      },
    });

    expect(found).toHaveBeenCalledWith(
      expect.objectContaining({
        markerId: 0,
        type: "barcode",
        confidence: 0.9,
        vertex,
        dir: 2,
      }),
    );
    // @ts-ignore private
    expect(plugin._frameInFlight).toBe(false);
  });

  it("an initialisation failure becomes ar:workerError", () => {
    const err = vi.fn();
    core.eventBus.on("ar:workerError", err);
    vi.spyOn(console, "error").mockImplementation(() => {});

    created.opts.onInitError(new Error("404 wasm"));

    expect(err).toHaveBeenCalledWith({
      message: expect.stringContaining("404 wasm"),
    });
  });
});
