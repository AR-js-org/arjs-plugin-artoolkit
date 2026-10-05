import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createARToolKitState: vi.fn(),
  disposeARToolKitState: vi.fn(),
  loadPatternMarker: vi.fn(),
  trackMarker: vi.fn(),
  processFrame: vi.fn(),
}));

vi.mock("@ar-js-org/artoolkit5-ts", () => mocks);

import { createDetector } from "../src/detector/artoolkit-detector.js";

describe("artoolkit-detector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createARToolKitState.mockResolvedValue({ id: "state" });
    mocks.loadPatternMarker.mockResolvedValue(7);
    mocks.processFrame.mockReturnValue({ detected: [], lost: [] });
  });

  it("creates state with the dimensions given to ensureReady, not at construction", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    expect(mocks.createARToolKitState).not.toHaveBeenCalled();

    await detector.ensureReady(1280, 720);

    expect(mocks.createARToolKitState).toHaveBeenCalledWith(
      1280,
      720,
      "/camera_para.dat",
      undefined,
    );
  });

  it("creates state only once across repeated ensureReady calls", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);
    await detector.ensureReady(640, 480);
    expect(mocks.createARToolKitState).toHaveBeenCalledTimes(1);
  });

  it("loads a pattern once per URL and tracks it", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);

    const first = await detector.loadPattern("/patt.hiro", 1);
    const second = await detector.loadPattern("/patt.hiro", 1);

    expect(first).toBe(7);
    expect(second).toBe(7);
    expect(mocks.loadPatternMarker).toHaveBeenCalledTimes(1);
    expect(mocks.trackMarker).toHaveBeenCalledWith({ id: "state" }, 7, 1);
  });

  it("loadPattern waits for readiness instead of failing when called first", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });

    const pending = detector.loadPattern("/patt.hiro", 1);
    await detector.ensureReady(640, 480);

    await expect(pending).resolves.toBe(7);
    expect(mocks.loadPatternMarker).toHaveBeenCalledTimes(1);
  });

  it("passes detected and lost markers through, projecting out the native matrix pose", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);
    const matrixGL = new Float32Array(16);
    const pose = {
      id: 3,
      type: "pattern",
      confidence: 0.9,
      // The native 3x4 Float64Array pose real artoolkit5-ts returns. It must
      // not survive into the projected result below.
      matrix: new Float64Array(12),
      matrixGL,
    };
    mocks.processFrame.mockReturnValue({
      detected: [pose],
      lost: [{ id: 4, type: "barcode" }],
    });

    const pixels = new Uint8ClampedArray(4);
    const result = detector.detect(pixels);

    expect(result.detected).toEqual([
      { id: 3, type: "pattern", confidence: 0.9, matrixGL },
    ]);
    expect(result.detected[0]).not.toHaveProperty("matrix");
    expect(result.lost).toEqual([{ id: 4, type: "barcode" }]);
  });

  it("forwards the detected square's corners", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);
    const vertex = [
      [10, 20],
      [30, 20],
      [30, 40],
      [10, 40],
    ];
    mocks.processFrame.mockReturnValue({
      detected: [
        {
          id: 3,
          type: "pattern",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
          vertex,
        },
      ],
      lost: [],
    });

    const result = detector.detect(new Uint8ClampedArray(4));

    expect(result.detected[0].vertex).toEqual(vertex);
  });

  it("forwards the marker's rotation alongside the corners", async () => {
    // `dir` is what makes the corner order interpretable, so it has to survive
    // the same projection `vertex` does. Asserting a non-zero value: 0 is the
    // value `(4 - dir) % 4` treats as the identity, so a dropped field would
    // look correct under that formula.
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);
    mocks.processFrame.mockReturnValue({
      detected: [
        {
          id: 3,
          type: "pattern",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
          vertex: [
            [10, 20],
            [30, 20],
            [30, 40],
            [10, 40],
          ],
          dir: 2,
        },
      ],
      lost: [],
    });

    const result = detector.detect(new Uint8ClampedArray(4));

    expect(result.detected[0].dir).toBe(2);
  });

  it("filters detections below minConfidence", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
      minConfidence: 0.6,
    });
    await detector.ensureReady(640, 480);
    mocks.processFrame.mockReturnValue({
      detected: [
        {
          id: 1,
          type: "pattern",
          confidence: 0.9,
          matrixGL: new Float32Array(16),
        },
        {
          id: 2,
          type: "pattern",
          confidence: 0.3,
          matrixGL: new Float32Array(16),
        },
      ],
      lost: [],
    });

    const result = detector.detect(new Uint8ClampedArray(4));

    expect(result.detected).toHaveLength(1);
    expect(result.detected[0].id).toBe(1);
  });

  it("applies a 0.6 confidence floor by default, matching pre-migration behaviour", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);
    mocks.processFrame.mockReturnValue({
      detected: [
        {
          id: 1,
          type: "pattern",
          confidence: 0.61,
          matrixGL: new Float32Array(16),
        },
        {
          id: 2,
          type: "pattern",
          confidence: 0.59,
          matrixGL: new Float32Array(16),
        },
      ],
      lost: [],
    });

    const result = detector.detect(new Uint8ClampedArray(4));

    expect(result.detected).toHaveLength(1);
    expect(result.detected[0].id).toBe(1);
  });

  it("returns empty results when detect is called before readiness", () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    expect(detector.detect(new Uint8ClampedArray(4))).toEqual({
      detected: [],
      lost: [],
    });
    expect(mocks.processFrame).not.toHaveBeenCalled();
  });

  it("backs off after a failed init instead of retrying every frame", async () => {
    mocks.createARToolKitState.mockRejectedValue(new Error("wasm missing"));
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });

    await expect(detector.ensureReady(640, 480)).resolves.toBe(false);
    await expect(detector.ensureReady(640, 480)).resolves.toBe(false);

    expect(mocks.createARToolKitState).toHaveBeenCalledTimes(1);
  });

  it("disposes the state and refuses further work", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);

    detector.dispose();
    detector.dispose();

    expect(mocks.disposeARToolKitState).toHaveBeenCalledTimes(1);
    expect(detector.detect(new Uint8ClampedArray(4))).toEqual({
      detected: [],
      lost: [],
    });
  });

  it("rejects loadPattern after dispose instead of using the freed state", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);
    detector.dispose();

    await expect(detector.loadPattern("/patt.hiro", 1)).rejects.toThrow(
      /disposed/i,
    );
    expect(mocks.loadPatternMarker).not.toHaveBeenCalled();
  });

  it("rejects a pending loadPattern when dispose happens before readiness", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    const pending = detector.loadPattern("/patt.hiro", 1);
    detector.dispose();

    await expect(pending).rejects.toThrow(/disposed/i);
  });

  it("rejects a pending loadPattern once initialisation has failed for good", async () => {
    vi.useFakeTimers();
    try {
      mocks.createARToolKitState.mockRejectedValue(new Error("wasm missing"));
      const detector = createDetector({
        cameraParametersUrl: "/camera_para.dat",
      });
      const pending = detector.loadPattern("/patt.hiro", 1);

      // Backoff blocks immediate retries, so step past it between attempts.
      for (let i = 0; i < 6; i++) {
        await detector.ensureReady(640, 480);
        vi.advanceTimersByTime(60000);
      }

      await expect(pending).rejects.toThrow(/failed/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes a state that finishes initialising after dispose was called", async () => {
    let resolveCreate;
    mocks.createARToolKitState.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });

    const readying = detector.ensureReady(640, 480);
    detector.dispose();
    resolveCreate({ id: "late-state" });
    await readying;

    expect(mocks.disposeARToolKitState).toHaveBeenCalledWith({
      id: "late-state",
    });
  });

  it("serves loadPattern again after recovering from an exhausted retry cycle", async () => {
    vi.useFakeTimers();
    try {
      mocks.createARToolKitState.mockRejectedValue(new Error("wasm missing"));
      const detector = createDetector({
        cameraParametersUrl: "/camera_para.dat",
      });
      const doomed = detector.loadPattern("/patt.hiro", 1);

      for (let i = 0; i < 6; i++) {
        await detector.ensureReady(640, 480);
        vi.advanceTimersByTime(60000);
      }
      await expect(doomed).rejects.toThrow(/failed/i);

      // The outage ends and initialisation succeeds.
      mocks.createARToolKitState.mockResolvedValue({ id: "state" });
      await detector.ensureReady(640, 480);

      await expect(detector.loadPattern("/patt.kanji", 1)).resolves.toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });
});
