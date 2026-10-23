import { describe, expect, it } from "vitest";
import { DAILY_AURA_SUBMISSION_LIMIT } from "../src/routes/aura-routes.js";

describe("Aura submission limits", () => {
  it("allows ten submissions per rolling 24-hour window", () => {
    expect(DAILY_AURA_SUBMISSION_LIMIT).toBe(10);
  });
});
