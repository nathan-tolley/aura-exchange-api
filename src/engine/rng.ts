/** Seeded randomness for the price engine. The engine never calls Math.random: the caller injects an Rng. */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
}

/**
 * sfc32, seeded through a string hash, so a seed like `${listingId}:${tickAt}` replays exactly.
 * Not for anything secret.
 */
export function seededRng(seed: string | number): Rng {
  const text = String(seed);
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const word = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
  let a = word(), b = word(), c = word(), d = word();
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) + t | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next();
  return { next };
}

export function uniform(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng.next();
}

/** Standard normal (Box–Muller). */
export function normal(rng: Rng): number {
  let u = rng.next();
  while (u === 0) u = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

/** Gamma(shape, 1) for shape ≥ 1 (Marsaglia–Tsang). */
function gamma(rng: Rng, shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng.next();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Student-t with `df` > 2 degrees of freedom, scaled to unit variance: fat tails, same spread as a normal. */
export function studentT(rng: Rng, df: number): number {
  const chiSquare = 2 * gamma(rng, df / 2);
  return (normal(rng) / Math.sqrt(chiSquare / df)) * Math.sqrt((df - 2) / df);
}

/** Waiting time until the next arrival of a Poisson process with `rate` arrivals per unit of time. */
export function exponential(rng: Rng, rate: number): number {
  return -Math.log(1 - rng.next()) / rate;
}
