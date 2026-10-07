import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { testConfigPath } from './scripts/harness-config.mjs'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [testConfigPath()] })],
  test: {
    include: ['packages/pkw/*/tests/**/*.spec.ts'],
    pool: 'forks',
    environment: 'node',
  },
})
