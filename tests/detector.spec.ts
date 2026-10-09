import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  configureDetector: vi.fn(),
  trackBarcodeMarker: vi.fn(),
  createARToolKitState: vi.fn(),
  disposeARToolKitState: vi.fn(),
  loadPatternMarker: vi.fn(),
  trackMarker: vi.fn(),
  processFrame: vi.fn(),
  getCameraProjectionMatrix: vi.fn(),
}));

vi.mock("@ar-js-org/artoolkit5-ts", () => mocks);

import { createDetector } from "../src/detector/artoolkit-detector.js";

/**
 * The settings the engine ended up with: every configureDetector call that
 * did not throw, folded in order the way artoolkit5-ts applies them. Only the
 * keys present change, and minConfidence changes per family.
 */
function engineSettings(): Record<string, any> {
  const out: Record<string, any> = {};
  mocks.configureDetector.mock.calls.forEach(([, opts], i) => {
    if (mocks.configureDetector.mock.results[i].type !== "return") return;
    for (const [key, value] of Object.entries(opts as object)) {
      out[key] =
        key === "minConfidence" ? { ...out.minConfidence, ...value } : value;
    }
  });
  return out;
}

/** A configureDetector that rejects `value` for `key`, as artoolkit5-ts does. */
function rejecting(key: string, value: unknown) {
  return (_state: unknown, opts: Record<string, unknown>) => {
    if (opts[key] === value) throw new Error(`bad ${key}`);
  };
}

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

  it("getProjectionMatrix returns null before ensureReady and the artoolkit5-ts matrix after", async () => {
    const lens = Float64Array.from({ length: 16 }, (_, i) => i);
    mocks.getCameraProjectionMatrix.mockReturnValue(lens);
    const detector = createDetector({ cameraParametersUrl: "/cam.dat" });

    expect(detector.getProjectionMatrix()).toBeNull();

    await detector.ensureReady(640, 480);

    expect(Array.from(detector.getProjectionMatrix()!)).toEqual(
      Array.from(lens),
    );
    expect(mocks.getCameraProjectionMatrix).toHaveBeenCalledTimes(1);
    expect(mocks.getCameraProjectionMatrix).toHaveBeenCalledWith({
      id: "state",
    });
  });

  it("the projection reflects nearPlane and farPlane given at construction", async () => {
    mocks.getCameraProjectionMatrix.mockReturnValue(new Float64Array(16));
    const detector = createDetector({ detectorOptions: { farPlane: 5000 } });

    await detector.ensureReady(640, 480);
    detector.getProjectionMatrix();

    const planes = mocks.configureDetector.mock.calls.findIndex(
      ([, opts]) => "farPlane" in (opts as object),
    );
    expect(planes).toBeGreaterThanOrEqual(0);
    expect(
      mocks.configureDetector.mock.invocationCallOrder[planes],
    ).toBeLessThan(
      mocks.getCameraProjectionMatrix.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("the projection follows a later configure of farPlane", async () => {
    const before = Float64Array.from({ length: 16 }, () => 1);
    const after = Float64Array.from({ length: 16 }, () => 2);
    mocks.getCameraProjectionMatrix.mockReturnValue(before);
    const detector = createDetector({});
    await detector.ensureReady(640, 480);
    expect(detector.getProjectionMatrix()![0]).toBe(1);

    mocks.getCameraProjectionMatrix.mockReturnValue(after);
    await detector.configure({ farPlane: 5000 });

    expect(detector.getProjectionMatrix()![0]).toBe(2);
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

  it("hands a numeric minConfidence to artoolkit5-ts for both families", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
      minConfidence: 0.7,
    });
    await detector.ensureReady(640, 480);

    expect(engineSettings()).toEqual({
      minConfidence: { pattern: 0.7, barcode: 0.7 },
    });
  });

  it("applies a 0.6 confidence floor by default, matching pre-migration behaviour", async () => {
    const detector = createDetector({
      cameraParametersUrl: "/camera_para.dat",
    });
    await detector.ensureReady(640, 480);

    expect(engineSettings()).toEqual({
      minConfidence: { pattern: 0.6, barcode: 0.6 },
    });
  });

  it("passes a per-family minConfidence through unchanged", async () => {
    const detector = createDetector({
      minConfidence: { pattern: 0.6, barcode: 0.5 },
    });
    await detector.ensureReady(640, 480);

    expect(engineSettings().minConfidence).toEqual({
      pattern: 0.6,
      barcode: 0.5,
    });
  });

  it("forwards detections as processFrame returns them, without filtering again", async () => {
    const detector = createDetector();
    await detector.ensureReady(640, 480);
    mocks.processFrame.mockReturnValue({
      detected: [
        {
          id: 2,
          type: "barcode",
          confidence: 0.3,
          matrixGL: new Float32Array(16),
        },
      ],
      lost: [],
    });

    expect(detector.detect(new Uint8ClampedArray(4)).detected).toHaveLength(1);
  });

  describe("configure", () => {
    it("queues options until the state exists, then applies them with the rest", async () => {
      const detector = createDetector({
        detectorOptions: { matrixCodeType: "4x4" },
      });
      const pending = detector.configure({ thresholdMode: "auto_otsu" });
      expect(mocks.configureDetector).not.toHaveBeenCalled();

      await detector.ensureReady(640, 480);

      expect(engineSettings()).toMatchObject({
        matrixCodeType: "4x4",
        thresholdMode: "auto_otsu",
      });
      await expect(pending).resolves.toMatchObject({
        matrixCodeType: "4x4",
        thresholdMode: "auto_otsu",
      });
    });

    it("settles a queued request only once its options are applied (#5)", async () => {
      const detector = createDetector();
      let settled = false;
      const pending = detector.configure({ threshold: 90 }).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      await detector.ensureReady(640, 480);
      await pending;

      expect(settled).toBe(true);
    });

    it("rejects a queued request with the option artoolkit5-ts refuses, without failing initialisation (#5)", async () => {
      mocks.configureDetector.mockImplementation(
        rejecting("detectionMode", "nope"),
      );
      const detector = createDetector();
      const pending = detector.configure({ detectionMode: "nope" });

      await expect(detector.ensureReady(640, 480)).resolves.toBe(true);

      await expect(pending).rejects.toThrow("bad detectionMode");
    });

    it("applies only the given keys once the state exists", async () => {
      const detector = createDetector();
      await detector.ensureReady(640, 480);
      mocks.configureDetector.mockClear();

      const config = await detector.configure({
        threshold: 120,
        minConfidence: 0.8,
      });

      expect(engineSettings()).toEqual({
        threshold: 120,
        minConfidence: { pattern: 0.8, barcode: 0.8 },
      });
      expect(config).toMatchObject({ threshold: 120 });
    });

    it("keeps the valid keys of a request with a rejected one, and leaves the rejected one out of the config", async () => {
      const detector = createDetector();
      await detector.ensureReady(640, 480);
      mocks.configureDetector.mockImplementation(
        rejecting("detectionMode", "nope"),
      );

      await expect(
        detector.configure({ threshold: 120, detectionMode: "nope" }),
      ).rejects.toThrow("bad detectionMode");

      const config = await detector.configure({});
      expect(engineSettings().threshold).toBe(120);
      expect(config.threshold).toBe(120);
      expect(config.detectionMode).toBeUndefined();
    });

    it("updating one family's minConfidence keeps the other family's floor (#7)", async () => {
      const detector = createDetector();
      const queued = detector.configure({ minConfidence: { barcode: 0.8 } });

      await detector.ensureReady(640, 480);

      expect(engineSettings().minConfidence).toEqual({
        pattern: 0.6,
        barcode: 0.8,
      });
      await expect(queued).resolves.toMatchObject({
        minConfidence: { pattern: 0.6, barcode: 0.8 },
      });
      await expect(
        detector.configure({ minConfidence: { pattern: 0.7 } }),
      ).resolves.toMatchObject({
        minConfidence: { pattern: 0.7, barcode: 0.8 },
      });
    });

    it("drops an option rejected at initialisation and reports it once, without skipping queued work (#2)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.configureDetector.mockImplementation(
        rejecting("matrixCodeType", "nope"),
      );
      const detector = createDetector({
        detectorOptions: { matrixCodeType: "nope", threshold: 100 },
      });
      const barcode = detector.trackBarcode(3);
      const pattern = detector.loadPattern("/patt.hiro", 1);

      await expect(detector.ensureReady(640, 480)).rejects.toThrow(
        "bad matrixCodeType",
      );

      await expect(barcode).resolves.toMatchObject({ markerId: 3 });
      expect(mocks.trackBarcodeMarker).toHaveBeenCalledWith(
        { id: "state" },
        3,
        1,
      );
      await expect(pattern).resolves.toBe(7);
      expect(engineSettings().threshold).toBe(100);
      const config = await detector.configure({});
      expect(config.matrixCodeType).toBeUndefined();
      expect(config.threshold).toBe(100);

      await expect(detector.ensureReady(640, 480)).resolves.toBe(true);
      expect(mocks.createARToolKitState).toHaveBeenCalledTimes(1);
    });

    it("publishes readiness only after the configuration and queued barcodes are applied (#2)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const detector = createDetector();
      const barcode = detector.trackBarcode(4);
      const pattern = detector.loadPattern("/patt.hiro", 1);

      await detector.ensureReady(640, 480);
      await Promise.all([barcode, pattern]);

      const firstLoad = mocks.loadPatternMarker.mock.invocationCallOrder[0];
      expect(
        Math.max(...mocks.configureDetector.mock.invocationCallOrder),
      ).toBeLessThan(firstLoad);
      expect(mocks.trackBarcodeMarker.mock.invocationCallOrder[0]).toBeLessThan(
        firstLoad,
      );
    });
  });

  describe("trackBarcode", () => {
    it("registers at once when ready, switching color to color_and_matrix", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const detector = createDetector();
      await detector.ensureReady(640, 480);
      mocks.configureDetector.mockClear();

      const result = await detector.trackBarcode(5, 2);

      expect(result).toEqual({
        markerId: 5,
        size: 2,
        detectionMode: "color_and_matrix",
      });
      expect(mocks.configureDetector).toHaveBeenCalledWith(
        { id: "state" },
        { detectionMode: "color_and_matrix" },
      );
      expect(mocks.trackBarcodeMarker).toHaveBeenCalledWith(
        { id: "state" },
        5,
        2,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("keeps a mono pipeline mono", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const detector = createDetector({
        detectorOptions: { detectionMode: "mono" },
      });
      await detector.ensureReady(640, 480);
      expect((await detector.trackBarcode(1)).detectionMode).toBe(
        "mono_and_matrix",
      );
      warn.mockRestore();
    });

    it("leaves a matrix-capable mode alone, without warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const detector = createDetector({
        detectorOptions: { detectionMode: "matrix" },
      });
      await detector.ensureReady(640, 480);
      expect((await detector.trackBarcode(1)).detectionMode).toBe("matrix");
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("queues barcodes until ready and registers them after the config", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const detector = createDetector();
      const zero = detector.trackBarcode(0, 1);
      const nine = detector.trackBarcode(9, 3);
      expect(mocks.trackBarcodeMarker).not.toHaveBeenCalled();

      await detector.ensureReady(640, 480);
      await Promise.all([zero, nine]);

      expect(engineSettings().detectionMode).toBe("color_and_matrix");
      expect(mocks.trackBarcodeMarker.mock.calls).toEqual([
        [{ id: "state" }, 0, 1],
        [{ id: "state" }, 9, 3],
      ]);
      expect(
        Math.max(...mocks.configureDetector.mock.invocationCallOrder),
      ).toBeLessThan(mocks.trackBarcodeMarker.mock.invocationCallOrder[0]);
    });

    it("a barcode artoolkit5-ts refuses does not stop the others (#2)", async () => {
      mocks.trackBarcodeMarker.mockImplementation((_state, id) => {
        if (id === 1) throw new Error("bad barcode");
      });
      const detector = createDetector({
        detectorOptions: { detectionMode: "matrix" },
      });
      const one = detector.trackBarcode(1);
      const two = detector.trackBarcode(2);

      await detector.ensureReady(640, 480);

      await expect(one).rejects.toThrow("bad barcode");
      await expect(two).resolves.toMatchObject({ markerId: 2 });
    });

    it("rejects ids that are not non-negative integers, before readiness", async () => {
      const detector = createDetector();
      await expect(detector.trackBarcode(-1)).rejects.toThrow(
        "Invalid barcodeId",
      );
      await expect(detector.trackBarcode(1.5)).rejects.toThrow(
        "Invalid barcodeId",
      );
      await expect(detector.trackBarcode(undefined)).rejects.toThrow(
        "Invalid barcodeId",
      );
    });

    it("refuses work after dispose", async () => {
      const detector = createDetector();
      detector.dispose();
      await expect(detector.trackBarcode(1)).rejects.toThrow(
        "Detector disposed",
      );
      await expect(detector.configure({})).rejects.toThrow("Detector disposed");
    });

    it("rejects requests still queued when the detector is disposed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const detector = createDetector();
      const config = detector.configure({ threshold: 90 });
      const barcode = detector.trackBarcode(1);

      detector.dispose();

      await expect(config).rejects.toThrow(/disposed/i);
      await expect(barcode).rejects.toThrow(/disposed/i);
    });

    it("rejects queued requests once initialisation has failed for good", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        mocks.createARToolKitState.mockRejectedValue(new Error("wasm missing"));
        const detector = createDetector();
        const config = detector.configure({ threshold: 90 });
        const barcode = detector.trackBarcode(1);

        for (let i = 0; i < 6; i++) {
          await detector.ensureReady(640, 480);
          vi.advanceTimersByTime(60000);
        }

        await expect(config).rejects.toThrow(/failed/i);
        await expect(barcode).rejects.toThrow(/failed/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("reports only the first failed initialisation of a cycle through onInitError", async () => {
    vi.useFakeTimers();
    try {
      const onInitError = vi.fn();
      mocks.createARToolKitState.mockRejectedValue(new Error("404 wasm"));
      const detector = createDetector({ onInitError });

      await detector.ensureReady(640, 480);
      vi.advanceTimersByTime(60000);
      await detector.ensureReady(640, 480);

      expect(mocks.createARToolKitState).toHaveBeenCalledTimes(2);
      expect(onInitError).toHaveBeenCalledTimes(1);
      expect(onInitError.mock.calls[0][0].message).toBe("404 wasm");
    } finally {
      vi.useRealTimers();
    }
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
