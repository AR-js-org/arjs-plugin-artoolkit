/**
 * Minimal ARToolKit plugin skeleton.
 * Conforms to the Engine Plugin contract: init(core), enable(), disable(), dispose()
 * Emits events via core.eventBus: 'ar:markerFound', 'ar:markerUpdated', 'ar:markerLost'
 */
export class ArtoolkitPlugin {
    constructor(options = {}) {
        this.options = options;
        this.core = null;
        this.enabled = false;
        this._onUpdate = null;
    }

    async init(core) {
        this.core = core;
        // load resources if needed
        return this;
    }

    async enable() {
        if (!this.core) throw new Error('Plugin not initialized');
        this.enabled = true;
        this._onUpdate = (payload) => this._onFrameUpdate(payload);
        this.core.eventBus.on('engine:update', this._onUpdate);
        return this;
    }

    async disable() {
        this.enabled = false;
        if (this._onUpdate) this.core.eventBus.off('engine:update', this._onUpdate);
        return this;
    }

    dispose() {
        return this.disable();
    }

    _onFrameUpdate({ deltaTime, context }) {
        // stub: read frame from context/resources and run detection
        // when detection occurs, emit:
        // this.core.eventBus.emit('ar:markerFound', { id, poseMatrix, confidence, corners });
    }

    getMarkerState(markerId) {
        return null;
    }
}