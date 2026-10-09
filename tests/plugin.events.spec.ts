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

  it("carries the square's corners on found and on updated", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    const updated = vi.fn();
    core.eventBus.on("ar:markerFound", found);
    core.eventBus.on("ar:markerUpdated", updated);

    const vertex = [
      [10, 20],
      [30, 20],
      [30, 40],
      [10, 40],
    ];
    const detected = [
      {
        id: 5,
        type: "pattern",
        confidence: 0.9,
        matrixGL: new Float32Array(16),
        vertex,
      },
    ];

    // Twice: the first sighting emits found, the second emits updated, and a
    // consumer drawing an outline needs the corners from both.
    for (const frameId of [1, 2]) {
      // @ts-ignore
      plugin._onWorkerMessage({
        data: {
          type: "detectionResult",
          payload: { frameId, detected, lost: [] },
        },
      });
    }

    expect(found.mock.calls[0][0].vertex).toEqual(vertex);
    expect(updated.mock.calls[0][0].vertex).toEqual(vertex);

    await plugin.disable();
  });

  it("carries the rotation on found and on updated", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    const updated = vi.fn();
    core.eventBus.on("ar:markerFound", found);
    core.eventBus.on("ar:markerUpdated", updated);

    const detected = [
      {
        id: 5,
        type: "pattern",
        confidence: 0.9,
        matrixGL: new Float32Array(16),
        vertex: [
          [10, 20],
          [30, 20],
          [30, 40],
          [10, 40],
        ],
        // Non-zero deliberately: `(4 - dir) % 4` is the identity at 0, so a
        // dropped field would still resolve to a plausible-looking corner.
        dir: 3,
      },
    ];

    for (const frameId of [1, 2]) {
      // @ts-ignore
      plugin._onWorkerMessage({
        data: {
          type: "detectionResult",
          payload: { frameId, detected, lost: [] },
        },
      });
    }

    expect(found.mock.calls[0][0].dir).toBe(3);
    expect(updated.mock.calls[0][0].dir).toBe(3);

    await plugin.disable();
  });

  it("resolves the marker's own top-left corner from vertex and dir", async () => {
    // The point of shipping both fields together: a consumer can name a printed
    // corner. This is the formula examples/simple-marker/ draws, pinned so a
    // change to either field that breaks the pairing is caught here.
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();

    const found = vi.fn();
    core.eventBus.on("ar:markerFound", found);

    // @ts-ignore
    plugin._onWorkerMessage({
      data: {
        type: "detectionResult",
        payload: {
          frameId: 1,
          detected: [
            {
              id: 5,
              type: "pattern",
              confidence: 0.9,
              matrixGL: new Float32Array(16),
              vertex: [
                [10, 20],
                [30, 20],
                [30, 40],
                [10, 40],
              ],
              dir: 1,
            },
          ],
          lost: [],
        },
      },
    });

    const { vertex, dir } = found.mock.calls[0][0];
    // dir 1 -> (4 - 1) % 4 -> vertex[3]
    expect(vertex[(4 - dir) % 4]).toEqual([10, 40]);

    await plugin.disable();
  });

  // The emitted contract is "well-formed or absent, never malformed". The
  // detections below are what a bypassed or stale detector produces; the plugin
  // must not pass the value on, and must not invent one either.
  describe("malformed vertex and dir are omitted rather than forwarded", () => {
    const cases: Array<[string, unknown, unknown]> = [
      ["vertex missing", undefined, 1],
      ["vertex not an array", { 0: [1, 2] }, 1],
      [
        "vertex with too few corners",
        [
          [1, 2],
          [3, 4],
        ],
        1,
      ],
      ["dir missing", null, undefined],
      ["dir not an integer", null, 1.5],
      ["dir above the range", null, 4],
      // The nastiest case, and the reason dir is range-checked rather than only
      // type-checked: (4 - -1) % 4 is 1, a perfectly valid index. A negative dir
      // would silently resolve to the wrong corner instead of throwing.
      ["dir negative", null, -1],
      ["dir a numeric string", null, "2"],
    ];

    for (const [name, badVertex, badDir] of cases) {
      it(name, async () => {
        const plugin = new ArtoolkitPlugin({ worker: false });
        await plugin.init(core);
        await plugin.enable();

        const found = vi.fn();
        core.eventBus.on("ar:markerFound", found);

        const goodVertex = [
          [10, 20],
          [30, 20],
          [30, 40],
          [10, 40],
        ];

        // @ts-ignore  deliberately malformed, which is the point
        plugin._onWorkerMessage({
          data: {
            type: "detectionResult",
            payload: {
              frameId: 1,
              detected: [
                {
                  id: 5,
                  type: "pattern",
                  confidence: 0.9,
                  matrixGL: new Float32Array(16),
                  vertex: badVertex === null ? goodVertex : badVertex,
                  dir: badDir,
                },
              ],
              lost: [],
            },
          },
        });

        const payload = found.mock.calls[0][0];

        // The event still fires: a bad corner set must not cost the detection.
        expect(payload.markerId).toBe(5);
        expect(payload.confidence).toBe(0.9);

        if (badVertex === null) {
          expect(payload.vertex).toEqual(goodVertex);
          expect(payload.dir).toBeUndefined();
        } else {
          expect(payload.vertex).toBeUndefined();
          expect(payload.dir).toBe(1);
        }

        await plugin.disable();
      });
    }

    it("keeps both keys on the payload even when the values are absent", async () => {
      // AGENTS.md documents the payload as a fixed shape, and a stable shape is
      // cheaper for the engine across a per-frame hot path. Absent means the
      // value is undefined, not that the key is missing.
      const plugin = new ArtoolkitPlugin({ worker: false });
      await plugin.init(core);
      await plugin.enable();

      const found = vi.fn();
      core.eventBus.on("ar:markerFound", found);

      // @ts-ignore  no vertex and no dir at all, as most detections in these
      // tests are written, and as a pre-0.3.0 detector would report
      plugin._onWorkerMessage({
        data: {
          type: "detectionResult",
          payload: {
            frameId: 1,
            detected: [
              {
                id: 5,
                type: "pattern",
                confidence: 0.9,
                matrixGL: new Float32Array(16),
              },
            ],
            lost: [],
          },
        },
      });

      const payload = found.mock.calls[0][0];
      expect("vertex" in payload).toBe(true);
      expect("dir" in payload).toBe(true);
      expect(payload.vertex).toBeUndefined();
      expect(payload.dir).toBeUndefined();

      await plugin.disable();
    });
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

describe("ar:camera", () => {
  let core: { eventBus: ReturnType<typeof createEventBus> };

  beforeEach(() => {
    core = { eventBus: createEventBus() };
  });

  const projection = Array.from({ length: 16 }, (_, i) => i / 2);

  it("emits ar:camera with a Float32Array and remembers it", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    await plugin.enable();
    const camera = vi.fn();
    core.eventBus.on("ar:camera", camera);

    // @ts-ignore
    plugin._onWorkerMessage({
      data: {
        type: "camera",
        payload: { projectionMatrix: projection, width: 640, height: 480 },
      },
    });

    expect(camera).toHaveBeenCalledTimes(1);
    const payload = camera.mock.calls[0][0];
    expect(payload.projectionMatrix).toBeInstanceOf(Float32Array);
    expect(Array.from(payload.projectionMatrix)).toEqual(projection);
    expect(payload.width).toBe(640);
    expect(payload.height).toBe(480);
    expect(typeof payload.timestamp).toBe("number");

    const remembered = plugin.getProjectionMatrix();
    expect(Array.from(remembered!)).toEqual(projection);
    expect(remembered).not.toBe(payload.projectionMatrix);
  });

  it("getProjectionMatrix is null before any camera message", async () => {
    const plugin = new ArtoolkitPlugin({ worker: false });
    await plugin.init(core);
    expect(plugin.getProjectionMatrix()).toBeNull();
  });
});
