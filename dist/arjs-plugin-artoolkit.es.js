const t = "0.1.2";
class m {
  constructor(g = {}) {
    this.options = {
      worker: !0,
      lostThreshold: 5,
      frameDurationMs: 200,
      sweepIntervalMs: 100,
      artoolkitModuleUrl: void 0,
      cameraParametersUrl: void 0,
      wasmBaseUrl: void 0,
      ...g
    }, this.core = null, this.enabled = !1, this._worker = null, this._onWorkerMessage = this._onWorkerMessage.bind(this), this._onEngineUpdate = this._onEngineUpdate.bind(this), this._markers = /* @__PURE__ */ new Map(), this.lostThreshold = this.options.lostThreshold, this.frameDurationMs = this.options.frameDurationMs, this.sweepIntervalMs = this.options.sweepIntervalMs, this.workerEnabled = this.options.worker, this._pendingMarkerLoads = /* @__PURE__ */ new Map(), this._nextLoadRequestId = 0, this.workerReady = !1, this.version = t;
  }
  /**
   * Initialize the plugin with the engine core.
   *
   * Stores the core reference and prepares the plugin.
   * Heavy initialization (worker setup) is deferred to enable().
   *
   * @param {Object} core - Engine core with eventBus
   * @param {Object} core.eventBus - Event bus for plugin communication
   * @returns {Promise<ArtoolkitPlugin>} This plugin instance
   */
  async init(g) {
    return this.core = g, console.log(
      `[ArtoolkitPlugin] ${this.version} Initialized with core`,
      g
    ), this;
  }
  /**
   * Enable the plugin and start marker detection.
   *
   * - Subscribes to engine:update events for frame processing
   * - Starts the detection worker (if workerEnabled)
   * - Begins marker sweep interval for lost-marker detection
   *
   * @returns {Promise<ArtoolkitPlugin>} This plugin instance
   * @throws {Error} If plugin not initialized via init()
   */
  async enable() {
    if (!this.core) throw new Error("Plugin not initialized");
    return this.enabled ? this : (this.enabled = !0, this.core.eventBus.on("engine:update", this._onEngineUpdate), this.workerEnabled && await this._startWorker(), this._sweepInterval = setInterval(
      () => this._sweepMarkers(),
      this.sweepIntervalMs
    ), this);
  }
  /**
   * Disable the plugin and stop marker detection.
   *
   * - Unsubscribes from engine:update events
   * - Stops and terminates the detection worker
   * - Clears the marker sweep interval
   *
   * @returns {Promise<ArtoolkitPlugin>} This plugin instance
   */
  async disable() {
    return this.enabled ? (this.enabled = !1, this.core.eventBus.off("engine:update", this._onEngineUpdate), this._worker && this._stopWorker(), this._sweepInterval && (clearInterval(this._sweepInterval), this._sweepInterval = null), this) : this;
  }
  /**
   * Dispose of the plugin and clean up resources.
   *
   * Alias for disable() - stops detection and terminates worker.
   *
   * @returns {Promise<ArtoolkitPlugin>} This plugin instance
   */
  dispose() {
    return this.disable();
  }
  /**
   * Engine frame update handler - forwards frames to the worker for processing.
   *
   * Receives frame data from the capture system and sends it to the detection worker.
   * In browsers, uses transferable ImageBitmap for zero-copy performance.
   *
   * @param {Object} frame - Frame data from capture system
   * @param {number} frame.id - Frame identifier
   * @param {number} frame.timestamp - Frame timestamp
   * @param {ImageBitmap} [frame.imageBitmap] - Browser-only transferable image data
   * @param {number} frame.width - Frame width in pixels
   * @param {number} frame.height - Frame height in pixels
   * @param {*} [frame.sourceRef] - Optional reference to source
   *
   * @private
   * @note After ImageBitmap transfer, the main thread's bitmap is neutered and cannot be reused
   */
  _onEngineUpdate(g) {
    if (g) {
      if (this._worker && g.imageBitmap) {
        try {
          typeof Worker < "u" ? this._worker.postMessage(
            {
              type: "processFrame",
              payload: {
                frameId: g.id,
                imageBitmap: g.imageBitmap,
                width: g.width,
                height: g.height
              }
            },
            // transfer list: ImageBitmap is transferable
            [g.imageBitmap]
          ) : this._worker.postMessage({
            type: "processFrame",
            payload: {
              frameId: g.id,
              width: g.width,
              height: g.height
            }
          });
        } catch (C) {
          console.warn(
            "Artoolkit worker postMessage (ImageBitmap) failed, falling back to frameId only",
            C
          );
          try {
            this._worker.postMessage({
              type: "processFrame",
              payload: { frameId: g.id }
            });
          } catch (l) {
            console.warn("worker postMessage failed", l);
          }
        }
        return;
      }
      if (this._worker)
        try {
          this._worker.postMessage({
            type: "processFrame",
            payload: { frameId: g.id }
          });
        } catch (C) {
          console.warn("Artoolkit worker postMessage failed", C);
        }
    }
  }
  /**
   * Start the detection worker (cross-platform).
   *
   * Creates and initializes a Web Worker (browser) or worker_threads.Worker (Node.js).
   * Attaches message handlers and sends initial configuration to the worker.
   *
   * **Browser:** Uses `new Worker(new URL(...), { type: 'module' })`
   * **Node.js:** Uses `worker_threads.Worker` with file path resolution
   *
   * Sends init message with:
   * - artoolkitModuleUrl: Custom ARToolKit module URL
   * - cameraParametersUrl: Camera calibration parameters
   * - wasmBaseUrl: Base URL for WASM files
   *
   * Includes watchdog timer to resend init if worker doesn't respond within 500ms.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _startWorker() {
    if (!this._worker) {
      if (typeof Worker < "u")
        this._worker = new Worker(
          new URL(
            /* @vite-ignore */
            "" + new URL("assets/worker-C6Ps5-k4.js", import.meta.url).href,
            import.meta.url
          ),
          { type: "module" }
        );
      else {
        const { Worker: g } = await Promise.resolve().then(() => Z), C = new URL("data:text/javascript;base64,LyoqDQogKiBAZmlsZW92ZXJ2aWV3IEFSVG9vbEtpdCBEZXRlY3Rpb24gV29ya2VyDQogKg0KICogQ3Jvc3MtcGxhdGZvcm0gd2ViIHdvcmtlciBmb3IgbWFya2VyIGRldGVjdGlvbiB1c2luZyBBUlRvb2xLaXQuDQogKiBSdW5zIG1hcmtlciB0cmFja2luZyBvZmYgdGhlIG1haW4gdGhyZWFkIGZvciBvcHRpbWFsIHBlcmZvcm1hbmNlLg0KICoNCiAqICoqQnJvd3NlciBQYXRoOioqDQogKiAtIFJlY2VpdmVzIEltYWdlQml0bWFwIHZpYSB0cmFuc2ZlcmFibGUgb2JqZWN0cyAoemVyby1jb3B5KQ0KICogLSBEcmF3cyB0byBPZmZzY3JlZW5DYW52YXMgZm9yIHByb2Nlc3NpbmcNCiAqIC0gUnVucyBBUlRvb2xLaXQucHJvY2VzcygpIG9uIGNhbnZhcy9JbWFnZURhdGENCiAqIC0gRm9yd2FyZHMgZmlsdGVyZWQgZ2V0TWFya2VyIGV2ZW50cyB0byBtYWluIHRocmVhZA0KICoNCiAqICoqRmVhdHVyZXM6KioNCiAqIC0gTGF6eSBpbml0aWFsaXphdGlvbiB3aXRoIGV4cG9uZW50aWFsIGJhY2tvZmYgb24gZmFpbHVyZXMNCiAqIC0gTWFya2VyIGxvYWRpbmcgYW5kIGRlZHVwbGljYXRpb24gYnkgcGF0dGVybiBVUkwNCiAqIC0gQ29uZmlkZW5jZS1iYXNlZCBmaWx0ZXJpbmcgKGNvbmZpZ3VyYWJsZSB2aWEgaW5pdCkNCiAqIC0gU2VsZWN0aXZlIGV2ZW50IGZvcndhcmRpbmcgZm9yIHRyYWNrZWQgcGF0dGVybiBJRHMgb25seQ0KICoNCiAqICoqTWVzc2FnZSBQcm90b2NvbDoqKg0KICogLSBgaW5pdGA6IENvbmZpZ3VyZSB3b3JrZXIgKG1vZHVsZVVybCwgY2FtZXJhUGFyYW1ldGVyc1VybCwgd2FzbUJhc2VVcmwsIG1pbkNvbmZpZGVuY2UpDQogKiAtIGBsb2FkTWFya2VyYDogTG9hZCBhIHBhdHRlcm4gbWFya2VyIGJ5IFVSTA0KICogLSBgcHJvY2Vzc0ZyYW1lYDogUHJvY2VzcyBJbWFnZUJpdG1hcCBmb3IgbWFya2VyIGRldGVjdGlvbg0KICoNCiAqICoqRW1pdHRlZCBFdmVudHM6KioNCiAqIC0gYHJlYWR5YDogV29ya2VyIGluaXRpYWxpemVkIGFuZCByZWFkeQ0KICogLSBgZ2V0TWFya2VyYDogRmlsdGVyZWQgbWFya2VyIGRldGVjdGlvbiBldmVudA0KICogLSBgbG9hZE1hcmtlclJlc3VsdGA6IFJlc3VsdCBvZiBsb2FkTWFya2VyIHJlcXVlc3QNCiAqIC0gYGVycm9yYDogRXJyb3Igb2NjdXJyZWQgZHVyaW5nIHByb2Nlc3NpbmcNCiAqDQogKiBAbW9kdWxlIHdvcmtlci93b3JrZXINCiAqLw0KDQpsZXQgYXJDb250cm9sbGVyID0gbnVsbDsNCmxldCBhckNvbnRyb2xsZXJJbml0aWFsaXplZCA9IGZhbHNlOw0KbGV0IGdldE1hcmtlckZvcndhcmRlckF0dGFjaGVkID0gZmFsc2U7DQoNCmxldCBvZmZzY3JlZW5DYW52YXMgPSBudWxsOw0KbGV0IG9mZnNjcmVlbkN0eCA9IG51bGw7DQpsZXQgY2FudmFzVyA9IDA7DQpsZXQgY2FudmFzSCA9IDA7DQoNCi8vIE1hcmtlciBhbmQgZmlsdGVyaW5nIHN0YXRlDQpjb25zdCBsb2FkZWRNYXJrZXJzID0gbmV3IE1hcCgpOyAvLyBwYXR0ZXJuVXJsIC0+IG1hcmtlcklkDQpjb25zdCBsb2FkaW5nTWFya2VycyA9IG5ldyBNYXAoKTsgLy8gcGF0dGVyblVybCAtPiBQcm9taXNlPG1hcmtlcklkPg0KY29uc3QgdHJhY2tlZFBhdHRlcm5JZHMgPSBuZXcgU2V0KCk7IC8vIFNldDxudW1iZXI+DQpsZXQgUEFUVEVSTl9NQVJLRVJfVFlQRSA9IDA7IC8vIHdpbGwgYmUgcmVhZCBmcm9tIEFSVG9vbGtpdCBpZiBhdmFpbGFibGUNCmxldCBNSU5fQ09ORklERU5DRSA9IDAuNjsgLy8gY29uZmlndXJhYmxlIHZpYSBpbml0IHBheWxvYWQNCg0KLy8gSW5pdCBiYWNrb2ZmIHN0YXRlDQpsZXQgaW5pdEluUHJvZ3Jlc3MgPSBudWxsOw0KbGV0IGluaXRGYWlsQ291bnQgPSAwOw0KbGV0IGluaXRGYWlsZWRVbnRpbCA9IDA7DQoNCi8vIEluaXQtdGltZSBvcHRpb25zIChvdmVycmlkYWJsZSBmcm9tIG1haW4gdGhyZWFkKQ0KbGV0IElOSVRfT1BUUyA9IHsNCiAgbW9kdWxlVXJsOiBudWxsLA0KICBjYW1lcmFQYXJhbWV0ZXJzVXJsOiBudWxsLA0KICB3YXNtQmFzZVVybDogbnVsbCwNCiAgbWluQ29uZmlkZW5jZTogbnVsbCwNCn07DQoNCi8vIEFubm91bmNlLXJlYWR5IGd1YXJkDQpsZXQgaGFzQW5ub3VuY2VkUmVhZHkgPSBmYWxzZTsNCg0KLyoqDQogKiBDcm9zcy1wbGF0Zm9ybSBtZXNzYWdlIGxpc3RlbmVyIHJlZ2lzdHJhdGlvbi4NCiAqDQogKiBBdHRhY2hlcyBhIG1lc3NhZ2UgaGFuZGxlciBmb3IgdGhlIHdvcmtlcidzIG1lc3NhZ2UgZXZlbnRzLg0KICogTm9ybWFsaXplcyBicm93c2VyIHdvcmtlciBtZXNzYWdlIGV2ZW50cyAoZXh0cmFjdHMgZXYuZGF0YSkuDQogKg0KICogQHBhcmFtIHtGdW5jdGlvbn0gZm4gLSBIYW5kbGVyIGZ1bmN0aW9uIHJlY2VpdmluZyBtZXNzYWdlIGRhdGENCiAqIEBwcml2YXRlDQogKi8NCmZ1bmN0aW9uIG9uTWVzc2FnZShmbikgew0KICAvLyBCcm93c2VyIHdvcmtlciBwYXRoDQogIHNlbGYuYWRkRXZlbnRMaXN0ZW5lcigibWVzc2FnZSIsIChldikgPT4gZm4oZXYuZGF0YSkpOw0KfQ0KDQovKioNCiAqIFNlbmQgYSBtZXNzYWdlIHRvIHRoZSBtYWluIHRocmVhZC4NCiAqDQogKiBAcGFyYW0ge09iamVjdH0gbXNnIC0gTWVzc2FnZSBvYmplY3QgdG8gc2VuZA0KICogQHBhcmFtIHtzdHJpbmd9IG1zZy50eXBlIC0gTWVzc2FnZSB0eXBlIGlkZW50aWZpZXINCiAqIEBwYXJhbSB7Kn0gW21zZy5wYXlsb2FkXSAtIE9wdGlvbmFsIG1lc3NhZ2UgcGF5bG9hZA0KICogQHByaXZhdGUNCiAqLw0KZnVuY3Rpb24gc2VuZE1lc3NhZ2UobXNnKSB7DQogIHNlbGYucG9zdE1lc3NhZ2UobXNnKTsNCn0NCg0KLyoqDQogKiBTZXJpYWxpemUgQVIuanMtc3R5bGUgZ2V0TWFya2VyIGV2ZW50IGludG8gYSB0cmFuc2ZlcmFibGUgcGF5bG9hZC4NCiAqDQogKiBDb252ZXJ0cyB0aGUgbWFya2VyIGV2ZW50IGludG8gYSBwbGFpbiBvYmplY3QgdGhhdCBjYW4gYmUgc2VudCB2aWEgcG9zdE1lc3NhZ2UsDQogKiBleHRyYWN0aW5nIG1hdHJpeCwgbWFya2VyIHByb3BlcnRpZXMsIGFuZCB2ZXJ0ZXggZGF0YS4NCiAqDQogKiBAcGFyYW0ge09iamVjdH0gZXYgLSBSYXcgZ2V0TWFya2VyIGV2ZW50IGZyb20gQVJUb29sS2l0DQogKiBAcmV0dXJucyB7T2JqZWN0fSBTZXJpYWxpemVkIHBheWxvYWQgd2l0aCB0eXBlLCBtYXRyaXgsIGFuZCBtYXJrZXIgcHJvcGVydGllcw0KICogQHByaXZhdGUNCiAqLw0KZnVuY3Rpb24gc2VyaWFsaXplR2V0TWFya2VyRXZlbnQoZXYpIHsNCiAgdHJ5IHsNCiAgICBjb25zdCBkYXRhID0gZXY/LmRhdGEgfHwge307DQogICAgY29uc3QgbWFya2VyID0gZGF0YS5tYXJrZXIgfHwge307DQogICAgY29uc3QgbWF0cml4ID0gQXJyYXkuaXNBcnJheShkYXRhLm1hdHJpeCkNCiAgICAgID8gZGF0YS5tYXRyaXguc2xpY2UoMCwgMTYpDQogICAgICA6IGRhdGEubWF0cml4ICYmIGRhdGEubWF0cml4Lmxlbmd0aA0KICAgICAgICA/IEFycmF5LmZyb20oZGF0YS5tYXRyaXgpLnNsaWNlKDAsIDE2KQ0KICAgICAgICA6IG51bGw7DQogICAgY29uc3QgdmVydGV4ID0gbWFya2VyLnZlcnRleA0KICAgICAgPyBBcnJheS5pc0FycmF5KG1hcmtlci52ZXJ0ZXgpDQogICAgICAgID8gbWFya2VyLnZlcnRleC5zbGljZSgpDQogICAgICAgIDogbnVsbA0KICAgICAgOiBtYXJrZXIuY29ybmVycw0KICAgICAgICA/IG1hcmtlci5jb3JuZXJzLmZsYXRNYXAoKGMpID0+IFtjLnggPz8gY1swXSwgYy55ID8/IGNbMV1dKQ0KICAgICAgICA6IG51bGw7DQoNCiAgICByZXR1cm4gew0KICAgICAgdHlwZTogZGF0YS50eXBlLCAvLyBlLmcuLCBBUlRvb2xraXQuUEFUVEVSTl9NQVJLRVINCiAgICAgIG1hdHJpeCwNCiAgICAgIG1hcmtlcjogew0KICAgICAgICBpZFBhdHQ6IG1hcmtlci5pZFBhdHQgPz8gbWFya2VyLnBhdHRlcm5JZCA/PyBtYXJrZXIucGF0dGVybl9pZCA/PyBudWxsLA0KICAgICAgICBpZE1hdHJpeDogbWFya2VyLmlkTWF0cml4ID8/IG51bGwsDQogICAgICAgIGNmUGF0dDogbWFya2VyLmNmUGF0dCA/PyBtYXJrZXIuY29uZmlkZW5jZSA/PyBudWxsLA0KICAgICAgICBjZk1hdHJpeDogbWFya2VyLmNmTWF0cml4ID8/IG51bGwsDQogICAgICAgIHZlcnRleDogdmVydGV4IHx8IG51bGwsDQogICAgICB9LA0KICAgIH07DQogIH0gY2F0Y2ggew0KICAgIHJldHVybiB7IHR5cGU6IG51bGwsIG1hdHJpeDogbnVsbCwgbWFya2VyOiB7fSB9Ow0KICB9DQp9DQoNCi8qKg0KICogRmlsdGVyIGZ1bmN0aW9uIHRvIGRldGVybWluZSBpZiBhIG1hcmtlciBldmVudCBzaG91bGQgYmUgZm9yd2FyZGVkIHRvIG1haW4gdGhyZWFkLg0KICoNCiAqIEFwcGxpZXMgbXVsdGlwbGUgZmlsdGVyczoNCiAqIC0gVHlwZSBtdXN0IG1hdGNoIFBBVFRFUk5fTUFSS0VSDQogKiAtIENvbmZpZGVuY2UgbXVzdCBtZWV0IE1JTl9DT05GSURFTkNFIHRocmVzaG9sZA0KICogLSBNYXRyaXggbXVzdCBleGlzdCB3aXRoIDE2KyB2YWx1ZXMNCiAqIC0gSWYgdHJhY2tpbmcgc3BlY2lmaWMgSURzLCBtYXJrZXIgSUQgbXVzdCBiZSBpbiB0cmFja2VkUGF0dGVybklkcw0KICoNCiAqIEBwYXJhbSB7T2JqZWN0fSBldmVudCAtIE1hcmtlciBldmVudCBmcm9tIEFSVG9vbEtpdA0KICogQHJldHVybnMge2Jvb2xlYW59IFRydWUgaWYgZXZlbnQgc2hvdWxkIGJlIGZvcndhcmRlZA0KICogQHByaXZhdGUNCiAqLw0KZnVuY3Rpb24gc2hvdWxkRm9yd2FyZEdldE1hcmtlcihldmVudCkgew0KICBjb25zdCBkYXRhID0gZXZlbnQ/LmRhdGEgfHwge307DQogIGNvbnN0IHR5cGUgPSBkYXRhLnR5cGU7DQogIGNvbnN0IG1hcmtlciA9IGRhdGEubWFya2VyIHx8IHt9Ow0KICBjb25zdCBpZCA9IG1hcmtlci5pZFBhdHQgPz8gbWFya2VyLnBhdHRlcm5JZCA/PyBtYXJrZXIucGF0dGVybl9pZCA/PyBudWxsOw0KICBjb25zdCBjb25mID0gbWFya2VyLmNmUGF0dCA/PyBtYXJrZXIuY29uZmlkZW5jZSA/PyAwOw0KICBjb25zdCBtYXRyaXggPSBkYXRhLm1hdHJpeDsNCg0KICAvLyBUeXBlIG11c3QgYmUgUEFUVEVSTl9NQVJLRVIgKGZhbGxiYWNrIG51bWVyaWMgMCBpZiBjb25zdGFudHMgbm90IGF2YWlsYWJsZSkNCiAgaWYgKHR5cGUgIT09IFBBVFRFUk5fTUFSS0VSX1RZUEUpIHJldHVybiBmYWxzZTsNCg0KICAvLyBDb25maWRlbmNlIGdhdGUNCiAgaWYgKCEoTnVtYmVyLmlzRmluaXRlKGNvbmYpICYmIGNvbmYgPj0gTUlOX0NPTkZJREVOQ0UpKSByZXR1cm4gZmFsc2U7DQoNCiAgLy8gTWF0cml4IG11c3QgZXhpc3Qgd2l0aCBhdCBsZWFzdCAxNiB2YWx1ZXMNCiAgY29uc3QgbSA9IEFycmF5LmlzQXJyYXkobWF0cml4KQ0KICAgID8gbWF0cml4DQogICAgOiAobWF0cml4ICYmIEFycmF5LmZyb20obWF0cml4KSkgfHwgbnVsbDsNCiAgaWYgKCFtIHx8IG0ubGVuZ3RoIDwgMTYpIHJldHVybiBmYWxzZTsNCg0KICAvLyBJZiB3ZSBoYXZlIHRyYWNrZWQgSURzLCBvbmx5IGZvcndhcmQgdGhvc2UgSURzDQogIGlmICh0cmFja2VkUGF0dGVybklkcy5zaXplICYmIGlkICE9IG51bGwgJiYgIXRyYWNrZWRQYXR0ZXJuSWRzLmhhcyhpZCkpDQogICAgcmV0dXJuIGZhbHNlOw0KDQogIHJldHVybiB0cnVlOw0KfQ0KDQovKioNCiAqIEF0dGFjaCBhIGZpbHRlcmVkIGV2ZW50IGZvcndhcmRlciB0byBBUkNvbnRyb2xsZXIncyBnZXRNYXJrZXIgZXZlbnRzLg0KICoNCiAqIFNldHMgdXAgYSBsaXN0ZW5lciB0aGF0IGZpbHRlcnMgbWFya2VyIGV2ZW50cyBiYXNlZCBvbiBjb25maWRlbmNlLCB0eXBlLA0KICogYW5kIHRyYWNrZWQgcGF0dGVybiBJRHMgYmVmb3JlIGZvcndhcmRpbmcgdG8gdGhlIG1haW4gdGhyZWFkLg0KICoNCiAqIE9ubHkgYXR0YWNoZXMgb25jZSAoZ3VhcmRlZCBieSBnZXRNYXJrZXJGb3J3YXJkZXJBdHRhY2hlZCBmbGFnKS4NCiAqDQogKiBAcHJpdmF0ZQ0KICovDQpmdW5jdGlvbiBhdHRhY2hHZXRNYXJrZXJGb3J3YXJkZXIoKSB7DQogIGlmICgNCiAgICAhYXJDb250cm9sbGVyIHx8DQogICAgdHlwZW9mIGFyQ29udHJvbGxlci5hZGRFdmVudExpc3RlbmVyICE9PSAiZnVuY3Rpb24iIHx8DQogICAgZ2V0TWFya2VyRm9yd2FyZGVyQXR0YWNoZWQNCiAgKQ0KICAgIHJldHVybjsNCiAgYXJDb250cm9sbGVyLmFkZEV2ZW50TGlzdGVuZXIoImdldE1hcmtlciIsIChldmVudCkgPT4gew0KICAgIGlmICghc2hvdWxkRm9yd2FyZEdldE1hcmtlcihldmVudCkpIHJldHVybjsNCiAgICBjb25zdCBwYXlsb2FkID0gc2VyaWFsaXplR2V0TWFya2VyRXZlbnQoZXZlbnQpOw0KICAgIHRyeSB7DQogICAgICBjb25zb2xlLmxvZygiW1dvcmtlcl0gZ2V0TWFya2VyIChmaWx0ZXJlZCkiLCBwYXlsb2FkKTsNCiAgICB9IGNhdGNoIHt9DQogICAgc2VuZE1lc3NhZ2UoeyB0eXBlOiAiZ2V0TWFya2VyIiwgcGF5bG9hZCB9KTsNCiAgfSk7DQogIGdldE1hcmtlckZvcndhcmRlckF0dGFjaGVkID0gdHJ1ZTsNCn0NCg0KLyoqDQogKiBJbml0aWFsaXplIEFSVG9vbEtpdCB3aXRoIGV4cG9uZW50aWFsIGJhY2tvZmYgb24gZmFpbHVyZXMuDQogKg0KICogTG9hZHMgdGhlIEFSVG9vbEtpdCBtb2R1bGUsIGNvbmZpZ3VyZXMgaXQgd2l0aCBpbml0IG9wdGlvbnMsDQogKiBjcmVhdGVzIGFuIEFSQ29udHJvbGxlciwgYW5kIGF0dGFjaGVzIHRoZSBnZXRNYXJrZXIgZXZlbnQgZm9yd2FyZGVyLg0KICoNCiAqICoqQmFja29mZiBTdHJhdGVneToqKg0KICogLSBPbiBmYWlsdXJlLCBkZWxheXMgcmV0cnkgd2l0aCBleHBvbmVudGlhbCBiYWNrb2ZmICh1cCB0byAzMCBzZWNvbmRzKQ0KICogLSBQcmV2ZW50cyByZXBlYXRlZCBpbml0aWFsaXphdGlvbiBhdHRlbXB0cyB3aGVuIGxpYnJhcnkgaXMgdW5hdmFpbGFibGUNCiAqDQogKiBAcGFyYW0ge251bWJlcn0gW3dpZHRoPTY0MF0gLSBWaWRlby9jYW52YXMgd2lkdGggZm9yIEFSQ29udHJvbGxlcg0KICogQHBhcmFtIHtudW1iZXJ9IFtoZWlnaHQ9NDgwXSAtIFZpZGVvL2NhbnZhcyBoZWlnaHQgZm9yIEFSQ29udHJvbGxlcg0KICogQHJldHVybnMge1Byb21pc2U8Ym9vbGVhbj59IFRydWUgaWYgaW5pdGlhbGl6ZWQgc3VjY2Vzc2Z1bGx5DQogKiBAcHJpdmF0ZQ0KICovDQphc3luYyBmdW5jdGlvbiBpbml0QXJ0b29sa2l0KHdpZHRoID0gNjQwLCBoZWlnaHQgPSA0ODApIHsNCiAgaWYgKGFyQ29udHJvbGxlckluaXRpYWxpemVkKSByZXR1cm4gdHJ1ZTsNCg0KICBjb25zdCBub3cgPSBEYXRlLm5vdygpOw0KICBpZiAobm93IDwgaW5pdEZhaWxlZFVudGlsKSB7DQogICAgY29uc3Qgd2FpdE1zID0gaW5pdEZhaWxlZFVudGlsIC0gbm93Ow0KICAgIGNvbnNvbGUud2FybigiW1dvcmtlcl0gaW5pdEFydG9vbGtpdCBza2lwcGVkIGR1ZSB0byBiYWNrb2ZmIChtcyk6Iiwgd2FpdE1zKTsNCiAgICByZXR1cm4gZmFsc2U7DQogIH0NCg0KICBpZiAoaW5pdEluUHJvZ3Jlc3MpIHsNCiAgICB0cnkgew0KICAgICAgYXdhaXQgaW5pdEluUHJvZ3Jlc3M7DQogICAgICByZXR1cm4gYXJDb250cm9sbGVySW5pdGlhbGl6ZWQ7DQogICAgfSBjYXRjaCB7DQogICAgICByZXR1cm4gZmFsc2U7DQogICAgfQ0KICB9DQoNCiAgaW5pdEluUHJvZ3Jlc3MgPSAoYXN5bmMgKCkgPT4gew0KICAgIHRyeSB7DQogICAgICBjb25zdCBqc2FydG9vbGtpdCA9IGF3YWl0IChhc3luYyAoKSA9PiB7DQogICAgICAgIGlmIChJTklUX09QVFMubW9kdWxlVXJsKSB7DQogICAgICAgICAgY29uc29sZS5sb2coDQogICAgICAgICAgICAiW1dvcmtlcl0gTG9hZGluZyBhcnRvb2xraXQgZnJvbSBtb2R1bGVVcmw6IiwNCiAgICAgICAgICAgIElOSVRfT1BUUy5tb2R1bGVVcmwsDQogICAgICAgICAgKTsNCiAgICAgICAgICByZXR1cm4gYXdhaXQgaW1wb3J0KElOSVRfT1BUUy5tb2R1bGVVcmwpOw0KICAgICAgICB9DQogICAgICAgIC8vIElmIHlvdXIgZW52aXJvbm1lbnQgc3VwcG9ydHMgYmFyZSBpbXBvcnQgKGltcG9ydCBtYXAvYnVuZGxlciksIHRoaXMgd2lsbCB3b3JrOg0KICAgICAgICByZXR1cm4gYXdhaXQgaW1wb3J0KCJAYXItanMtb3JnL2FydG9vbGtpdDUtanMiKTsNCiAgICAgIH0pKCk7DQoNCiAgICAgIC8vIFNhZmVseSBleHRyYWN0IGV4cG9ydHMgKHN1cHBvcnRzIGJvdGggbmFtZWQgYW5kIGRlZmF1bHQgZXhwb3J0cykNCiAgICAgIGNvbnN0IEFSQ29udHJvbGxlciA9DQogICAgICAgIGpzYXJ0b29sa2l0LkFSQ29udHJvbGxlciA/PyBqc2FydG9vbGtpdC5kZWZhdWx0Py5BUkNvbnRyb2xsZXI7DQogICAgICBjb25zdCBBUlRvb2xraXQgPSBqc2FydG9vbGtpdC5BUlRvb2xraXQgPz8ganNhcnRvb2xraXQuZGVmYXVsdD8uQVJUb29sa2l0Ow0KDQogICAgICBpZiAoIUFSQ29udHJvbGxlcikgew0KICAgICAgICB0aHJvdyBuZXcgRXJyb3IoIkFSQ29udHJvbGxlciBleHBvcnQgbm90IGZvdW5kIGluIEFSVG9vbEtpdCBtb2R1bGUiKTsNCiAgICAgIH0NCg0KICAgICAgLy8gUmVhZCB0aGUgY29uc3RhbnQgaWYgYXZhaWxhYmxlOyBlbHNlIGtlZXAgZGVmYXVsdCAwDQogICAgICBpZiAoQVJUb29sa2l0ICYmIHR5cGVvZiBBUlRvb2xraXQuUEFUVEVSTl9NQVJLRVIgPT09ICJudW1iZXIiKSB7DQogICAgICAgIFBBVFRFUk5fTUFSS0VSX1RZUEUgPSBBUlRvb2xraXQuUEFUVEVSTl9NQVJLRVI7DQogICAgICB9DQoNCiAgICAgIGlmIChJTklUX09QVFMud2FzbUJhc2VVcmwgJiYgQVJDb250cm9sbGVyKSB7DQogICAgICAgIHRyeSB7DQogICAgICAgICAgQVJDb250cm9sbGVyLmJhc2VVUkwgPSBJTklUX09QVFMud2FzbUJhc2VVcmwuZW5kc1dpdGgoIi8iKQ0KICAgICAgICAgICAgPyBJTklUX09QVFMud2FzbUJhc2VVcmwNCiAgICAgICAgICAgIDogSU5JVF9PUFRTLndhc21CYXNlVXJsICsgIi8iOw0KICAgICAgICB9IGNhdGNoIHt9DQogICAgICB9DQoNCiAgICAgIGlmICh0eXBlb2YgSU5JVF9PUFRTLm1pbkNvbmZpZGVuY2UgPT09ICJudW1iZXIiKSB7DQogICAgICAgIE1JTl9DT05GSURFTkNFID0gSU5JVF9PUFRTLm1pbkNvbmZpZGVuY2U7DQogICAgICB9DQoNCiAgICAgIGNvbnN0IGNhbVVybCA9DQogICAgICAgIElOSVRfT1BUUy5jYW1lcmFQYXJhbWV0ZXJzVXJsIHx8DQogICAgICAgICJodHRwczovL3Jhdy5naXRoYWNrLmNvbS9BUi1qcy1vcmcvQVIuanMvbWFzdGVyL2RhdGEvZGF0YS9jYW1lcmFfcGFyYS5kYXQiOw0KDQogICAgICBjb25zb2xlLmxvZygiW1dvcmtlcl0gQVJUb29sS2l0IGluaXQiLCB7DQogICAgICAgIHdpZHRoLA0KICAgICAgICBoZWlnaHQsDQogICAgICAgIGNhbVVybCwNCiAgICAgICAgbWluQ29uZmlkZW5jZTogTUlOX0NPTkZJREVOQ0UsDQogICAgICAgIHBhdHRlcm5UeXBlOiBQQVRURVJOX01BUktFUl9UWVBFLA0KICAgICAgfSk7DQogICAgICBhckNvbnRyb2xsZXIgPSBhd2FpdCBBUkNvbnRyb2xsZXIuaW5pdFdpdGhEaW1lbnNpb25zKA0KICAgICAgICB3aWR0aCwNCiAgICAgICAgaGVpZ2h0LA0KICAgICAgICBjYW1VcmwsDQogICAgICAgIHt9LA0KICAgICAgKTsNCiAgICAgIGFyQ29udHJvbGxlckluaXRpYWxpemVkID0gISFhckNvbnRyb2xsZXI7DQogICAgICBjb25zb2xlLmxvZygiW1dvcmtlcl0gQVJUb29sS2l0IGluaXRpYWxpemVkOiIsIGFyQ29udHJvbGxlckluaXRpYWxpemVkKTsNCg0KICAgICAgaWYgKCFhckNvbnRyb2xsZXJJbml0aWFsaXplZCkNCiAgICAgICAgdGhyb3cgbmV3IEVycm9yKA0KICAgICAgICAgICJBUkNvbnRyb2xsZXIuaW5pdFdpdGhEaW1lbnNpb25zIHJldHVybmVkIGZhbHN5IGNvbnRyb2xsZXIiLA0KICAgICAgICApOw0KDQogICAgICBhdHRhY2hHZXRNYXJrZXJGb3J3YXJkZXIoKTsNCg0KICAgICAgaW5pdEZhaWxDb3VudCA9IDA7DQogICAgICBpbml0RmFpbGVkVW50aWwgPSAwOw0KICAgIH0gY2F0Y2ggKGVycikgew0KICAgICAgY29uc29sZS5lcnJvcigiW1dvcmtlcl0gQVJUb29sS2l0IGluaXQgZmFpbGVkOiIsIGVycik7DQogICAgICBhckNvbnRyb2xsZXIgPSBudWxsOw0KICAgICAgYXJDb250cm9sbGVySW5pdGlhbGl6ZWQgPSBmYWxzZTsNCg0KICAgICAgaW5pdEZhaWxDb3VudCA9IE1hdGgubWluKGluaXRGYWlsQ291bnQgKyAxLCA2KTsNCiAgICAgIGNvbnN0IGRlbGF5ID0gTWF0aC5taW4oMzAwMDAsIDEwMDAgKiBNYXRoLnBvdygyLCBpbml0RmFpbENvdW50KSk7DQogICAgICBpbml0RmFpbGVkVW50aWwgPSBEYXRlLm5vdygpICsgZGVsYXk7DQoNCiAgICAgIHNlbmRNZXNzYWdlKHsNCiAgICAgICAgdHlwZTogImVycm9yIiwNCiAgICAgICAgcGF5bG9hZDogew0KICAgICAgICAgIG1lc3NhZ2U6IGBBUlRvb2xLaXQgaW5pdCBmYWlsZWQgKCR7ZXJyPy5tZXNzYWdlIHx8IGVycn0pLiBSZXRyeWluZyBpbiAke2RlbGF5fW1zLmAsDQogICAgICAgIH0sDQogICAgICB9KTsNCiAgICAgIHRocm93IGVycjsNCiAgICB9IGZpbmFsbHkgew0KICAgICAgaW5pdEluUHJvZ3Jlc3MgPSBudWxsOw0KICAgIH0NCiAgfSkoKTsNCg0KICB0cnkgew0KICAgIGF3YWl0IGluaXRJblByb2dyZXNzOw0KICB9IGNhdGNoIHt9DQogIHJldHVybiBhckNvbnRyb2xsZXJJbml0aWFsaXplZDsNCn0NCg0KLyoqDQogKiBMb2FkIGEgcGF0dGVybiBtYXJrZXIsIGRlZHVwbGljYXRpbmcgcmVxdWVzdHMgYnkgVVJMLg0KICoNCiAqIEVuc3VyZXMgZWFjaCBwYXR0ZXJuIFVSTCBpcyBsb2FkZWQgb25seSBvbmNlLCBldmVuIGlmIHJlcXVlc3RlZCBtdWx0aXBsZSB0aW1lcy4NCiAqIFRyYWNrcyB0aGUgbG9hZGVkIG1hcmtlciBJRCBpbiB0cmFja2VkUGF0dGVybklkcyBmb3IgZXZlbnQgZmlsdGVyaW5nLg0KICoNCiAqIEBwYXJhbSB7c3RyaW5nfSBwYXR0ZXJuVXJsIC0gVVJMIHRvIHRoZSBwYXR0ZXJuIGZpbGUgKC5wYXR0KQ0KICogQHJldHVybnMge1Byb21pc2U8bnVtYmVyPn0gTWFya2VyIElEIGFzc2lnbmVkIGJ5IEFSVG9vbEtpdA0KICogQHRocm93cyB7RXJyb3J9IElmIG1hcmtlciBsb2FkaW5nIGZhaWxzDQogKiBAcHJpdmF0ZQ0KICovDQphc3luYyBmdW5jdGlvbiBsb2FkUGF0dGVybk9uY2UocGF0dGVyblVybCkgew0KICBpZiAobG9hZGVkTWFya2Vycy5oYXMocGF0dGVyblVybCkpIHJldHVybiBsb2FkZWRNYXJrZXJzLmdldChwYXR0ZXJuVXJsKTsNCiAgaWYgKGxvYWRpbmdNYXJrZXJzLmhhcyhwYXR0ZXJuVXJsKSkgcmV0dXJuIGxvYWRpbmdNYXJrZXJzLmdldChwYXR0ZXJuVXJsKTsNCg0KICBjb25zdCBwID0gKGFzeW5jICgpID0+IHsNCiAgICBjb25zdCBpZCA9IGF3YWl0IGFyQ29udHJvbGxlci5sb2FkTWFya2VyKHBhdHRlcm5VcmwpOw0KICAgIGxvYWRlZE1hcmtlcnMuc2V0KHBhdHRlcm5VcmwsIGlkKTsNCiAgICB0cmFja2VkUGF0dGVybklkcy5hZGQoaWQpOw0KICAgIGxvYWRpbmdNYXJrZXJzLmRlbGV0ZShwYXR0ZXJuVXJsKTsNCiAgICByZXR1cm4gaWQ7DQogIH0pKCkuY2F0Y2goKGUpID0+IHsNCiAgICBsb2FkaW5nTWFya2Vycy5kZWxldGUocGF0dGVyblVybCk7DQogICAgdGhyb3cgZTsNCiAgfSk7DQoNCiAgbG9hZGluZ01hcmtlcnMuc2V0KHBhdHRlcm5VcmwsIHApOw0KICByZXR1cm4gcDsNCn0NCg0Kb25NZXNzYWdlKGFzeW5jIChldikgPT4gew0KICBjb25zdCB7IHR5cGUsIHBheWxvYWQgfSA9IGV2IHx8IHt9Ow0KICB0cnkgew0KICAgIGlmICh0eXBlID09PSAiaW5pdCIpIHsNCiAgICAgIGlmIChwYXlsb2FkICYmIHR5cGVvZiBwYXlsb2FkID09PSAib2JqZWN0Iikgew0KICAgICAgICBJTklUX09QVFMubW9kdWxlVXJsID0gcGF5bG9hZC5tb2R1bGVVcmwgPz8gSU5JVF9PUFRTLm1vZHVsZVVybDsNCiAgICAgICAgSU5JVF9PUFRTLmNhbWVyYVBhcmFtZXRlcnNVcmwgPQ0KICAgICAgICAgIHBheWxvYWQuY2FtZXJhUGFyYW1ldGVyc1VybCA/PyBJTklUX09QVFMuY2FtZXJhUGFyYW1ldGVyc1VybDsNCiAgICAgICAgSU5JVF9PUFRTLndhc21CYXNlVXJsID0gcGF5bG9hZC53YXNtQmFzZVVybCA/PyBJTklUX09QVFMud2FzbUJhc2VVcmw7DQogICAgICAgIGlmICh0eXBlb2YgcGF5bG9hZC5taW5Db25maWRlbmNlID09PSAibnVtYmVyIikgew0KICAgICAgICAgIElOSVRfT1BUUy5taW5Db25maWRlbmNlID0gcGF5bG9hZC5taW5Db25maWRlbmNlOw0KICAgICAgICAgIE1JTl9DT05GSURFTkNFID0gcGF5bG9hZC5taW5Db25maWRlbmNlOw0KICAgICAgICB9DQogICAgICB9DQogICAgICBpZiAoIWhhc0Fubm91bmNlZFJlYWR5KSB7DQogICAgICAgIHNlbmRNZXNzYWdlKHsgdHlwZTogInJlYWR5IiB9KTsNCiAgICAgICAgaGFzQW5ub3VuY2VkUmVhZHkgPSB0cnVlOw0KICAgICAgfQ0KICAgICAgcmV0dXJuOw0KICAgIH0NCg0KICAgIGlmICh0eXBlID09PSAibG9hZE1hcmtlciIpIHsNCiAgICAgIGNvbnN0IHsgcGF0dGVyblVybCwgc2l6ZSA9IDEsIHJlcXVlc3RJZCB9ID0gcGF5bG9hZCB8fCB7fTsNCiAgICAgIGlmICghcGF0dGVyblVybCkgew0KICAgICAgICBzZW5kTWVzc2FnZSh7DQogICAgICAgICAgdHlwZTogImxvYWRNYXJrZXJSZXN1bHQiLA0KICAgICAgICAgIHBheWxvYWQ6IHsNCiAgICAgICAgICAgIG9rOiBmYWxzZSwNCiAgICAgICAgICAgIGVycm9yOiAiTWlzc2luZyBwYXR0ZXJuVXJsIHBhcmFtZXRlciIsDQogICAgICAgICAgICByZXF1ZXN0SWQsDQogICAgICAgICAgfSwNCiAgICAgICAgfSk7DQogICAgICAgIHJldHVybjsNCiAgICAgIH0NCiAgICAgIHRyeSB7DQogICAgICAgIGNvbnN0IG9rID0gYXdhaXQgaW5pdEFydG9vbGtpdCg2NDAsIDQ4MCk7DQogICAgICAgIGlmICghb2spIHRocm93IG5ldyBFcnJvcigiQVJUb29sS2l0IG5vdCBpbml0aWFsaXplZCIpOw0KDQogICAgICAgIGNvbnN0IG1hcmtlcklkID0gYXdhaXQgbG9hZFBhdHRlcm5PbmNlKHBhdHRlcm5VcmwpOw0KICAgICAgICBpZiAodHlwZW9mIGFyQ29udHJvbGxlci50cmFja1BhdHRlcm5NYXJrZXJJZCA9PT0gImZ1bmN0aW9uIikgew0KICAgICAgICAgIGFyQ29udHJvbGxlci50cmFja1BhdHRlcm5NYXJrZXJJZChtYXJrZXJJZCwgc2l6ZSk7DQogICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGFyQ29udHJvbGxlci50cmFja1BhdHRlcm5NYXJrZXIgPT09ICJmdW5jdGlvbiIpIHsNCiAgICAgICAgICBhckNvbnRyb2xsZXIudHJhY2tQYXR0ZXJuTWFya2VyKG1hcmtlcklkLCBzaXplKTsNCiAgICAgICAgfQ0KICAgICAgICBzZW5kTWVzc2FnZSh7DQogICAgICAgICAgdHlwZTogImxvYWRNYXJrZXJSZXN1bHQiLA0KICAgICAgICAgIHBheWxvYWQ6IHsgb2s6IHRydWUsIG1hcmtlcklkLCBzaXplLCByZXF1ZXN0SWQgfSwNCiAgICAgICAgfSk7DQogICAgICB9IGNhdGNoIChlcnIpIHsNCiAgICAgICAgY29uc29sZS5lcnJvcigiW1dvcmtlcl0gbG9hZE1hcmtlciBlcnJvcjoiLCBlcnIpOw0KICAgICAgICBzZW5kTWVzc2FnZSh7DQogICAgICAgICAgdHlwZTogImxvYWRNYXJrZXJSZXN1bHQiLA0KICAgICAgICAgIHBheWxvYWQ6IHsgb2s6IGZhbHNlLCBlcnJvcjogZXJyPy5tZXNzYWdlIHx8IFN0cmluZyhlcnIpLCByZXF1ZXN0SWQgfSwNCiAgICAgICAgfSk7DQogICAgICB9DQogICAgICByZXR1cm47DQogICAgfQ0KDQogICAgaWYgKHR5cGUgPT09ICJwcm9jZXNzRnJhbWUiKSB7DQogICAgICBjb25zdCB7IGltYWdlQml0bWFwLCB3aWR0aCwgaGVpZ2h0IH0gPSBwYXlsb2FkIHx8IHt9Ow0KICAgICAgaWYgKGltYWdlQml0bWFwKSB7DQogICAgICAgIHRyeSB7DQogICAgICAgICAgY29uc3QgdyA9IHdpZHRoIHx8IGltYWdlQml0bWFwLndpZHRoIHx8IDY0MDsNCiAgICAgICAgICBjb25zdCBoID0gaGVpZ2h0IHx8IGltYWdlQml0bWFwLmhlaWdodCB8fCA0ODA7DQoNCiAgICAgICAgICBhd2FpdCBpbml0QXJ0b29sa2l0KHcsIGgpOw0KDQogICAgICAgICAgaWYgKCFvZmZzY3JlZW5DYW52YXMgfHwgY2FudmFzVyAhPT0gdyB8fCBjYW52YXNIICE9PSBoKSB7DQogICAgICAgICAgICBjYW52YXNXID0gdzsNCiAgICAgICAgICAgIGNhbnZhc0ggPSBoOw0KICAgICAgICAgICAgb2Zmc2NyZWVuQ2FudmFzID0gbmV3IE9mZnNjcmVlbkNhbnZhcyhjYW52YXNXLCBjYW52YXNIKTsNCiAgICAgICAgICAgIG9mZnNjcmVlbkN0eCA9IG9mZnNjcmVlbkNhbnZhcy5nZXRDb250ZXh0KCIyZCIsIHsNCiAgICAgICAgICAgICAgd2lsbFJlYWRGcmVxdWVudGx5OiB0cnVlLA0KICAgICAgICAgICAgfSk7DQogICAgICAgICAgfQ0KDQogICAgICAgICAgb2Zmc2NyZWVuQ3R4LmNsZWFyUmVjdCgwLCAwLCBjYW52YXNXLCBjYW52YXNIKTsNCiAgICAgICAgICBvZmZzY3JlZW5DdHguZHJhd0ltYWdlKGltYWdlQml0bWFwLCAwLCAwLCBjYW52YXNXLCBjYW52YXNIKTsNCiAgICAgICAgICB0cnkgew0KICAgICAgICAgICAgaW1hZ2VCaXRtYXAuY2xvc2U/LigpOw0KICAgICAgICAgIH0gY2F0Y2gge30NCg0KICAgICAgICAgIGlmIChhckNvbnRyb2xsZXJJbml0aWFsaXplZCAmJiBhckNvbnRyb2xsZXIpIHsNCiAgICAgICAgICAgIHRyeSB7DQogICAgICAgICAgICAgIGFyQ29udHJvbGxlci5wcm9jZXNzKG9mZnNjcmVlbkNhbnZhcyk7DQogICAgICAgICAgICB9IGNhdGNoIChlKSB7DQogICAgICAgICAgICAgIHRyeSB7DQogICAgICAgICAgICAgICAgY29uc3QgaW1nRGF0YSA9IG9mZnNjcmVlbkN0eC5nZXRJbWFnZURhdGEoDQogICAgICAgICAgICAgICAgICAwLA0KICAgICAgICAgICAgICAgICAgMCwNCiAgICAgICAgICAgICAgICAgIGNhbnZhc1csDQogICAgICAgICAgICAgICAgICBjYW52YXNILA0KICAgICAgICAgICAgICAgICk7DQogICAgICAgICAgICAgICAgYXJDb250cm9sbGVyLnByb2Nlc3MoaW1nRGF0YSk7DQogICAgICAgICAgICAgIH0gY2F0Y2ggKGlubmVyKSB7DQogICAgICAgICAgICAgICAgY29uc29sZS53YXJuKA0KICAgICAgICAgICAgICAgICAgIltXb3JrZXJdIEFSVG9vbEtpdCBwcm9jZXNzIGZhbGxiYWNrIGZhaWxlZDoiLA0KICAgICAgICAgICAgICAgICAgaW5uZXIsDQogICAgICAgICAgICAgICAgKTsNCiAgICAgICAgICAgICAgfQ0KICAgICAgICAgICAgfQ0KICAgICAgICAgIH0NCiAgICAgICAgfSBjYXRjaCAoZXJyKSB7DQogICAgICAgICAgY29uc29sZS5lcnJvcigiW1dvcmtlcl0gcHJvY2Vzc0ZyYW1lIGVycm9yOiIsIGVycik7DQogICAgICAgIH0NCiAgICAgICAgcmV0dXJuOw0KICAgICAgfQ0KDQogICAgICAvLyBOb24tSW1hZ2VCaXRtYXAgcGF0aDogbm9vcA0KICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNSkpOw0KICAgICAgcmV0dXJuOw0KICAgIH0NCiAgfSBjYXRjaCAoZXJyKSB7DQogICAgc2VuZE1lc3NhZ2Uoew0KICAgICAgdHlwZTogImVycm9yIiwNCiAgICAgIHBheWxvYWQ6IHsgbWVzc2FnZTogZXJyPy5tZXNzYWdlIHx8IFN0cmluZyhlcnIpIH0sDQogICAgfSk7DQogIH0NCn0pOw0KDQovLyBBbm5vdW5jZSByZWFkeSByaWdodCBhZnRlciBsb2FkLCBpbiBjYXNlICdpbml0JyBpcyBkZWxheWVkDQp0cnkgew0KICBpZiAoIWhhc0Fubm91bmNlZFJlYWR5KSB7DQogICAgc2VuZE1lc3NhZ2UoeyB0eXBlOiAicmVhZHkiIH0pOw0KICAgIGhhc0Fubm91bmNlZFJlYWR5ID0gdHJ1ZTsNCiAgfQ0KfSBjYXRjaCB7fQ0K", import.meta.url), { fileURLToPath: l } = await Promise.resolve().then(() => Z), I = l(C);
        this._worker = new g(I, { type: "module" });
      }
      this._worker.addEventListener ? this._worker.addEventListener("message", this._onWorkerMessage) : this._worker.on && this._worker.on("message", this._onWorkerMessage);
      try {
        this._worker.postMessage?.({
          type: "init",
          payload: {
            moduleUrl: this.options.artoolkitModuleUrl || null,
            cameraParametersUrl: this.options.cameraParametersUrl || null,
            wasmBaseUrl: this.options.wasmBaseUrl || null
          }
        }), setTimeout(() => {
          if (!this.workerReady)
            try {
              this._worker?.postMessage?.({ type: "init", payload: {} });
            } catch {
            }
        }, 500);
      } catch {
      }
    }
  }
  /**
   * Stop and terminate the detection worker.
   *
   * Removes message event handlers and terminates the worker thread.
   * Works for both browser Workers and Node.js worker_threads.
   *
   * @private
   */
  _stopWorker() {
    if (this._worker) {
      this._worker.removeEventListener ? this._worker.removeEventListener("message", this._onWorkerMessage) : this._worker.off && this._worker.off("message", this._onWorkerMessage);
      try {
        typeof Worker < "u" ? this._worker.terminate() : this._worker.terminate?.();
      } catch {
      }
      this._worker = null;
    }
  }
  /**
   * Apply detection results and emit appropriate marker events.
   *
   * Normalizes detection data and determines whether to emit markerFound or markerUpdated.
   * Updates internal marker tracking state (lastSeen, visible, lostCount).
   *
   * **Event Logic:**
   * - First detection or previously invisible → emits `ar:markerFound`
   * - Already visible → emits `ar:markerUpdated`
   *
   * @param {Array<Object>} detections - Array of detection results from worker
   * @param {number} detections[].id - Marker ID
   * @param {Array<number>} detections[].poseMatrix - 16-element pose matrix
   * @param {number} [detections[].confidence=0] - Detection confidence (0-1)
   * @param {Array<Array<number>>} [detections[].corners=[]] - Marker corner coordinates
   *
   * @private
   */
  _applyDetections(g) {
    if (!(!g || !Array.isArray(g)))
      for (const C of g) {
        const l = C?.id;
        if (l == null) continue;
        const I = Date.now(), A = new Float32Array(C.poseMatrix || []), i = C.confidence ?? 0, e = C.corners ?? [], c = this._markers.get(l);
        !c || !c.visible ? (this._markers.set(l, { lastSeen: I, visible: !0, lostCount: 0 }), this.core?.eventBus?.emit("ar:markerFound", {
          id: l,
          poseMatrix: A,
          confidence: i,
          corners: e,
          timestamp: I
        })) : (c.lastSeen = I, c.lostCount = 0, this._markers.set(l, c), this.core?.eventBus?.emit("ar:markerUpdated", {
          id: l,
          poseMatrix: A,
          confidence: i,
          corners: e,
          timestamp: I
        }));
      }
  }
  /**
   * Handle messages from the detection worker.
   *
   * Processes different message types and routes them appropriately:
   * - `ready`: Worker initialized, sets workerReady flag
   * - `detectionResult`: Normalized detection data, applies via _applyDetections
   * - `getMarker`: AR.js-style marker event, forwards to event bus and converts to detection
   * - `loadMarkerResult`: Response to loadMarker request, resolves/rejects promise
   * - `error`: Worker error, emits ar:workerError event
   *
   * **Cross-platform handling:**
   * - Browser workers wrap messages in `event.data`
   * - Node.js worker_threads pass raw payload
   *
   * @param {Object|MessageEvent} ev - Message event from worker
   * @param {Object} [ev.data] - Message data (browser workers)
   * @param {string} ev.data.type - Message type
   * @param {*} ev.data.payload - Message payload
   *
   * @private
   */
  _onWorkerMessage(g) {
    const C = g && g.data !== void 0 ? g.data : g, { type: l, payload: I } = C || {};
    if (l === "ready")
      console.log("[Plugin] Worker ready"), this.workerReady = !0, this.core?.eventBus?.emit("ar:workerReady", {});
    else if (l === "detectionResult") {
      if (console.log("[Plugin] Received detectionResult:", I), !I || !Array.isArray(I.detections)) return;
      this._applyDetections(I.detections);
    } else if (l === "getMarker") {
      try {
        console.log("[Plugin] getMarker", I);
      } catch {
      }
      this.core?.eventBus?.emit("ar:getMarker", I);
      try {
        const A = I?.marker || {}, i = A.idPatt ?? A.patternId ?? A.pattern_id ?? null;
        let e = null;
        Array.isArray(I?.matrix) ? e = I.matrix.slice(0, 16) : I?.matrix && typeof I.matrix.length == "number" && (e = Array.from(I.matrix).slice(0, 16));
        let c = [];
        const o = A.vertex;
        if (Array.isArray(o))
          for (let d = 0; d + 1 < o.length; d += 2)
            c.push([o[d], o[d + 1]]);
        const s = A.cfPatt ?? A.confidence ?? 0;
        i != null && e && e.length === 16 && this._applyDetections([
          {
            id: i,
            confidence: s,
            poseMatrix: e,
            corners: c
          }
        ]);
      } catch {
      }
    } else if (l === "loadMarkerResult") {
      console.log("[Plugin] Received loadMarkerResult:", I);
      const { requestId: A, ok: i, error: e, markerId: c, size: o } = I || {};
      if (A !== void 0) {
        const s = this._pendingMarkerLoads.get(A);
        s && (this._pendingMarkerLoads.delete(A), i ? s.resolve({ markerId: c, size: o }) : s.reject(new Error(e || "Failed to load marker")));
      }
    } else l === "error" && (console.error("Artoolkit worker error", I), this.core?.eventBus?.emit("ar:workerError", I));
  }
  /**
   * Internal sweep to detect and emit lost markers.
   *
   * Checks all tracked markers against the lost threshold.
   * Markers not seen recently are removed and ar:markerLost is emitted.
   *
   * @private
   */
  _sweepMarkers() {
    const g = Date.now(), C = this.lostThreshold * this.frameDurationMs;
    for (const [l, I] of this._markers.entries())
      g - (I.lastSeen || 0) > C && (this._markers.delete(l), this.core.eventBus.emit("ar:markerLost", { id: l, timestamp: g }));
  }
  /**
   * Get the current tracking state of a marker.
   *
   * @param {number} markerId - Marker ID to query
   * @returns {Object|null} Marker state object with lastSeen, visible, lostCount, or null if not tracked
   *
   * @example
   * const state = plugin.getMarkerState(42);
   * if (state && state.visible) {
   *   console.log('Marker 42 last seen:', state.lastSeen);
   * }
   */
  getMarkerState(g) {
    return this._markers.get(g) || null;
  }
  /**
   * Load a pattern marker from a URL
   * @param {string} patternUrl - URL to the pattern file (absolute or repo-relative)
   * @param {number} size - Size of the marker in world units (default: 1)
   * @returns {Promise<{markerId: number, size: number}>} - Resolves with marker info when loaded
   */
  async loadMarker(g, C = 1) {
    if (!this._worker)
      throw new Error(
        "Worker not available. Ensure plugin is enabled and worker is running."
      );
    return console.log(`[Plugin] Loading marker: ${g} with size ${C}`), new Promise((l, I) => {
      const A = this._nextLoadRequestId++;
      this._pendingMarkerLoads.set(A, { resolve: l, reject: I });
      try {
        this._worker.postMessage({
          type: "loadMarker",
          payload: { patternUrl: g, size: C, requestId: A }
        });
      } catch (i) {
        this._pendingMarkerLoads.delete(A), I(new Error(`Failed to send loadMarker message: ${i.message}`));
      }
      setTimeout(() => {
        this._pendingMarkerLoads.has(A) && (this._pendingMarkerLoads.delete(A), I(new Error("loadMarker request timed out")));
      }, 1e4);
    });
  }
}
function G(b) {
  const g = new Float32Array(16);
  for (let C = 0; C < 16; C++) g[C] = b[C];
  return g;
}
const Z = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null
}, Symbol.toStringTag, { value: "Module" }));
export {
  t as ARTOOLKIT_PLUGIN_VERSION,
  m as ArtoolkitPlugin,
  G as convertModelViewToThreeMatrix
};
//# sourceMappingURL=arjs-plugin-artoolkit.es.js.map
