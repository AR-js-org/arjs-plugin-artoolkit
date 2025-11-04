import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: 'src/index.js',
            name: 'ARjsPluginARtoolkit',
            fileName: (format) => `arjs-plugin-artoolkit.${format}.js`,
            formats: ['es'], // ESM-only build
        },
        rollupOptions: {
            output: {
                // Do NOT override entryFileNames so Vite uses lib.fileName for the entry
                // Worker and other assets will still be emitted under assets/
                assetFileNames: (assetInfo) => {
                    if (assetInfo.name && assetInfo.name.includes('worker')) {
                        return 'assets/[name]-[hash][extname]';
                    }
                    return 'assets/[name]-[hash][extname]';
                },
            },
        },
        sourcemap: true,
        target: 'esnext',
    },
    worker: {
        format: 'es',
    },
});