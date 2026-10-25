import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spec } from "./openapi.js";

// The 0.5 check: every x-phase 0 operation has a contract test that validates a success response against the spec.

const contractDir = path.resolve("tests/contract");
const assertions = new Set<string>();
for (const file of readdirSync(contractDir).filter((name) => name.endsWith(".test.ts"))) {
  const source = readFileSync(path.join(contractDir, file), "utf8");
  for (const match of source.matchAll(/expectResponseMatchesSpec\("(get|post|patch|delete)", "([^"]+)", (2\d\d)/g)) {
    assertions.add(`${match[1]!.toUpperCase()} ${match[2]}`);
  }
}

describe("phase 0 contract coverage", () => {
  it("validates a success response for every x-phase 0 operation", () => {
    const phaseZero: string[] = [];
    for (const [specPath, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if ((operation as { "x-phase"?: unknown })["x-phase"] === 0) phaseZero.push(`${method.toUpperCase()} ${specPath}`);
      }
    }
    expect(phaseZero.length).toBeGreaterThan(15);
    expect(phaseZero.filter((operation) => !assertions.has(operation))).toEqual([]);
  });
});
