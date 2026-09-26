import { defineConfig } from 'vitest/config'

// Unit tests cover framework-free logic in lib/ (tests/unit + colocated lib/**/*.test.ts); no Nuxt runtime.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'lib/**/*.test.ts'],
  },
})
