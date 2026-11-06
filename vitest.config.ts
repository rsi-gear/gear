import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/build-runtime.mjs'],
    include: ['tests/**/*.spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
