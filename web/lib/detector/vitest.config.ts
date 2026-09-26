import { defineConfig } from 'vitest/config'

// Standalone config so the detector can be tested in isolation:
//   npx -y vitest@5.0.2 run --root web/lib/detector
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
  },
})
