import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        setupFiles: ['./tests/setupTests.ts'],
        coverage: {
            provider: 'v8',
            all: true,
            include: ['src/**/*.js'],
            thresholds: {
                lines: 60,
                statements: 60,
                branches: 50,
                functions: 60
            }
        }
    }
});