/** News shocks: impact score → fair-value move (PLAN.md → Force 1). Pure. */

export const MAX_IMPACT = 30;
const SCALE = 0.25;
const EXPONENT = 1.4;

const clampImpact = (impact: number) => Math.max(-MAX_IMPACT, Math.min(MAX_IMPACT, impact));

/** m(d) = sign(d)·0.25·(|d|/30)^1.4, as a fraction: 10 → 0.054, 20 → 0.142, 30 → 0.25. `d` is clamped to ±30. */
export function newsMove(impact: number): number {
  const d = clampImpact(impact);
  return Math.sign(d) * SCALE * (Math.abs(d) / MAX_IMPACT) ** EXPONENT;
}

/** The inverse of m(d): the impact score a fair-value move corresponds to, capped at ±30. */
export function impactOfMove(move: number): number {
  return clampImpact(Math.sign(move) * MAX_IMPACT * (Math.abs(move) / SCALE) ** (1 / EXPONENT));
}

/** The extra move when a ruled event's impact changes from `from` to `to` (up/down votes, an appeal). */
export function followOnMove(from: number, to: number): number {
  return (1 + newsMove(to)) / (1 + newsMove(from)) - 1;
}
