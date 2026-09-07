import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(import.meta.dirname, '../..'),
  test: {
    include: ['repros/candidate-runtime-validation/*.spec.ts'],
    testTimeout: 20_000,
  },
})
