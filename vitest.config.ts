import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/pkw/*/tests/**/*.spec.ts'],
    pool: 'forks',
    environment: 'node',
  },
})
