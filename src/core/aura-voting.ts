import { Decimal } from "decimal.js";

export type AuraVote = -1 | 0 | 1;

export function voteAdjustment(baseDelta: Decimal.Value, previousVote: AuraVote, nextVote: AuraVote): Decimal {
  return new Decimal(baseDelta).abs().mul("0.10").mul(nextVote - previousVote).toDecimalPlaces(2);
}

export function effectiveAuraDelta(baseDelta: Decimal.Value, voteScore: number): number {
  const base = new Decimal(baseDelta);
  return base.plus(base.abs().mul("0.10").mul(voteScore)).toDecimalPlaces(2).toNumber();
}
