import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

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
}));
const createDetector = vi.hoisted(() => vi.fn(() => detector));

vi.mock("../src/detector/artoolkit-detector.js", () => ({ createDetector }));

const posted: Array<{ type: string; payload?: Record<string, unknown> }> = [];
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
    detector.trackBarcode.mockReturnValue({
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
    detector.configure.mockReturnValueOnce({ threshold: 90 });
    expect(
      await send("configure", { opts: { threshold: 90 }, requestId: 3 }),
    ).toEqual({
      type: "configureResult",
      payload: { ok: true, config: { threshold: 90 }, requestId: 3 },
    });

    detector.configure.mockImplementationOnce(() => {
      throw new Error("bad");
    });
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
