import { defineConfig } from 'vite';

export default defineConfig({
    // Ensure asset URLs are relative to the built module (not absolute at site root)
    base: './',
    build: {
        lib: {
            entry: 'src/index.js',
            name: 'ARjsPluginARtoolkit',
            fileName: (format) => `arjs-plugin-artoolkit.${format}.js`,
            formats: ['esm'], // ESM-only build
        },
        rollupOptions: {
            output: {
                // Keep assets under assets/; relative path is enforced by base: './'
                assetFileNames: 'assets/[name]-[hash][extname]',
                // Let Vite/rollup choose relative paths tied to the lib entry; no need to force chunks dirs
            },
        },
        sourcemap: true,
        target: 'esnext',
    },
    worker: {
        format: 'es',
    },
});