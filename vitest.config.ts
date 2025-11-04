import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        setupFiles: ['./tests/setupTests.ts'],
        coverage: {
            provider: 'v8',
            all: true,
            include: ['src/**/*.js'],
            exclude: ['src/worker/**', 'src/index.js'],
            thresholds: {
                lines: 65,
                statements: 65,
                branches: 50,
                functions: 65,
            },
        },
    },
});