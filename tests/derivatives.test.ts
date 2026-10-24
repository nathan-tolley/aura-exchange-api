import {describe,expect,it} from "vitest";
import {impliedProbability,optionPayout,optionPremium,strikeSet} from "../src/core/derivatives.js";

describe("derivatives math",()=>{
  it("uses seeded pooled stakes for prediction odds",()=>{
    expect(impliedProbability(0,0)).toBe(50);
    expect(impliedProbability(300,100)).toBe(66.7);
  });
  it("prices and settles calls and puts",()=>{
    expect(optionPremium(100,100,"CALL",7*86_400_000).toNumber()).toBe(4);
    expect(optionPayout(120,100,"CALL",2).toNumber()).toBe(40);
    expect(optionPayout(80,100,"PUT",2).toNumber()).toBe(40);
    expect(optionPayout(80,100,"CALL",2).toNumber()).toBe(0);
  });
  it("offers rounded strikes around spot",()=>expect(strikeSet(103)).toEqual([93,103,113]));
});
