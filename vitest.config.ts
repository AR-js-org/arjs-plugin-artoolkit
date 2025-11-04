import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        setupFiles: ['./tests/setupTests.ts'],
        coverage: {
            provider: 'v8',
            all: true,
            include: ['src/**/*.js'],
            // Exclude files that are either pure re-exports or not yet unit-testable (worker)
            exclude: ['src/worker/**', 'src/index.js'],
            thresholds: {
                // Slightly relaxed thresholds while we build out more tests
                lines: 50,
                statements: 50,
                branches: 40,
                functions: 50,
            },
        },
    },
});