/**
 * Dev smoke test (Node): quick manual sanity check for plugin lifecycle.
 * Not part of the published package (ignored via .npmignore).
 * Run with: npm run smoke:node
 */
import { ArtoolkitPlugin } from '../src/plugin.js';

// Minimal eventBus stub
const eventBus = {
  _h: new Map(),
  on(e, h) { if (!this._h.has(e)) this._h.set(e, []); this._h.get(e).push(h); },
  off(e, h) { if (!this._h.has(e)) return; const a = this._h.get(e); this._h.set(e, a.filter(x => x !== h)); },
  emit(e, p) { (this._h.get(e) || []).forEach(h => { try { h(p); } catch (err) { console.error(err); } }); }
};

const core = { eventBus };

async function run() {
  // Use worker:false for Node environment; worker path depends on browser globals (self, ImageBitmap).
  const plugin = new ArtoolkitPlugin({ worker: false });
  await plugin.init(core);
  await plugin.enable();

  eventBus.on('ar:markerFound', d => console.log('FOUND', d));
  eventBus.on('ar:markerUpdated', d => console.log('UPDATED', d));
  eventBus.on('ar:markerLost', d => console.log('LOST', d));
  eventBus.on('ar:workerReady', () => console.log('Worker ready (unexpected in worker:false mode)'));

  console.log('Plugin version:', plugin.version);

  let id = 0;
  const iv = setInterval(() => {
    eventBus.emit('engine:update', { id: ++id, timestamp: Date.now() }); // No ImageBitmap in Node
    if (id >= 10) {
      clearInterval(iv);
      setTimeout(async () => {
        await plugin.disable();
        console.log('plugin disabled');
      }, 500);
    }
  }, 100);
}

run().catch(console.error);
