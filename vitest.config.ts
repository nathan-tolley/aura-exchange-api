import { defineConfig } from "vitest/config";

// DB-backed tests run against a throwaway database, rebuilt by tests/global-setup.ts on every run.
// Start it with: docker compose -f compose.dev.yaml up -d
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://aura:aura_dev_password@localhost:5433/aura_test";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: { DATABASE_URL: testDatabaseUrl, TEST_DATABASE_URL: testDatabaseUrl, NODE_ENV: "test" },
    coverage: { reporter: ["text", "html"] }
  }
});
