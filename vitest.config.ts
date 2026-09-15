import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli.ts',
        'src/controller.ts',
        'src/discord-bridge.ts',
        'src/integration-main.ts',
        'src/onboarding.ts',
        'src/openshell.ts',
        'src/slack-bridge.ts',
      ],
      thresholds: { lines: 70, statements: 70, functions: 70, branches: 60 }
    }
  }
});
