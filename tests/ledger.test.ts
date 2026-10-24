import { describe, expect, it } from "vitest";
import { normalizeBalancedPostings } from "../src/core/ledger.js";

describe("ledger normalization", () => {
  it("absorbs a one-unit decimal residue", () => {
    const postings=normalizeBalancedPostings([
      {accountKey:"user",amount:"-10.00000000"},
      {accountKey:"pool",amount:"9.99500000"},
      {accountKey:"fees",amount:"0.00500001"}
    ]);
    expect(postings.reduce((sum,item)=>sum.plus(item.amount),postings[0]!.amount.minus(postings[0]!.amount)).toFixed(8)).toBe("0.00000000");
  });

  it("rejects a materially unbalanced transaction", () => {
    expect(()=>normalizeBalancedPostings([
      {accountKey:"user",amount:-10},
      {accountKey:"pool",amount:9.99}
    ])).toThrow(/Unbalanced ledger transaction/);
  });
});
