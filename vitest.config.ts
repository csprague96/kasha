import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests for the main-process and shared logic. Modules that touch
// Electron or the data folder are mocked in each test.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
