import { describe, expect, it } from "vitest";
import { effectiveAuraDelta, voteAdjustment } from "../src/core/aura-voting.js";

describe("Aura voting", () => {
  it("makes upvotes positive and downvotes negative regardless of the original ruling", () => {
    expect(effectiveAuraDelta(3, 2)).toBe(3.6);
    expect(effectiveAuraDelta(-5, 1)).toBe(-4.5);
    expect(effectiveAuraDelta(-5, -1)).toBe(-5.5);
  });

  it("applies only the difference when a vote changes", () => {
    expect(voteAdjustment(4, 0, 1).toNumber()).toBe(0.4);
    expect(voteAdjustment(4, 1, -1).toNumber()).toBe(-0.8);
    expect(voteAdjustment(4, -1, 0).toNumber()).toBe(0.4);
    expect(voteAdjustment(-4, 0, 1).toNumber()).toBe(0.4);
    expect(voteAdjustment(-4, 1, -1).toNumber()).toBe(-0.8);
  });
});
