import { defineConfig } from 'vitest/config'
import { timeoutMs } from './shared.mjs'

export default defineConfig({ test: { testTimeout: timeoutMs } })
