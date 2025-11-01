import { ArtoolkitPlugin } from '../src/plugin.js';

// minimal eventBus stub
const eventBus = {
    _h: new Map(),
    on(e, h) { if (!this._h.has(e)) this._h.set(e, []); this._h.get(e).push(h); },
    off(e, h) { if (!this._h.has(e)) return; const a = this._h.get(e); this._h.set(e, a.filter(x=>x!==h)); },
    emit(e, p) { (this._h.get(e) || []).forEach(h => { try { h(p); } catch (err) { console.error(err); } }); }
};

const core = { eventBus };

async function run() {
    const plugin = new ArtoolkitPlugin({ worker: true });
    await plugin.init(core);
    await plugin.enable();

    // Listen to marker events:
    eventBus.on('ar:markerFound', d => console.log('FOUND', d));
    eventBus.on('ar:markerUpdated', d => console.log('UPDATED', d));
    eventBus.on('ar:markerLost', d => console.log('LOST', d));
    eventBus.on('ar:workerReady', () => console.log('Worker ready'));

    // Emit engine:update frames periodically to trigger worker processing
    let id = 0;
    const iv = setInterval(() => {
        eventBus.emit('engine:update', { id: ++id, timestamp: Date.now() });
        if (id >= 10) {
            clearInterval(iv);
            // wait a bit and then stop plugin
            setTimeout(async () => {
                await plugin.disable();
                console.log('plugin disabled');
            }, 1000);
        }
    }, 100);
}

run().catch(console.error);