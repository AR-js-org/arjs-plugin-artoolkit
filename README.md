# arjs-plugin-artoolkit
```markdown
# @ar-js-org/arjs-plugin-artoolkit

Minimal ARToolKit detection plugin scaffold for AR.js core.

## Usage

Register with the Engine plugin manager:

```js
import { ArtoolkitPlugin } from '@ar-js-org/arjs-plugin-artoolkit';

engine.pluginManager.register('artoolkit', new ArtoolkitPlugin({ /* options */ }));
await engine.pluginManager.enable('artoolkit');
```

The plugin emits events on the engine event bus:
- `ar:markerFound`
- `ar:markerUpdated`
- `ar:markerLost`

This repo contains a skeleton. Detection and worker/WASM integration will be implemented in follow-up work.
```