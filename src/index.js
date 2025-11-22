/**
 * @fileoverview ARToolKit Plugin for AR.js - Main entry point
 * 
 * Exports the core ArtoolkitPlugin class for marker-based AR tracking
 * and utility functions for coordinate system transformations.
 * 
 * @module arjs-plugin-artoolkit
 */

/**
 * The main plugin class for ARToolKit integration.
 * Manages worker lifecycle, marker detection, and event emission.
 */
export { ArtoolkitPlugin } from './plugin.js';

/**
 * Exported version constant (injected at build time by Vite).
 * Falls back to 'unknown' in non-build environments.
 */
export { ARTOOLKIT_PLUGIN_VERSION } from './plugin.js';

/**
 * Converts ARToolKit modelView matrices to Three.js compatible format.
 * Handles coordinate system differences between ARToolKit and Three.js.
 */
export { convertModelViewToThreeMatrix } from './utils/matrix.js';