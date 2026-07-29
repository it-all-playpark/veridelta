import { defineConfig } from 'vitest/config'
import { slowTestThresholdMs } from './shared.mjs'

export default defineConfig({
  test: { slowTestThreshold: slowTestThresholdMs },
})
