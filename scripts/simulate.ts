import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SIM_CONFIG, runSeason, type SeasonResult, type SimConfig, type Sources } from "./sim/season.js";

/**
 * pnpm sim: replays fake seasons through the price engine and prints how much of the price movement came from
 * events, trades and noise (PLAN.md's target: 60 / 25 / 15). Writes the first run's CSVs into sim-out/ for charts.
 *
 *   pnpm sim                                          one season, seed 1
 *   pnpm sim --seed 7 --runs 5                        five seasons, seeds 7–11, mean ± sd
 *   pnpm sim --set events.perListingPerDay=2          override any config value (repeatable)
 *   pnpm sim --sweep trading.casualPerHour=0.2,0.4    one line per value
 *   pnpm sim --weeks 2 --tick 60 --no-csv             quicker, for exploring
 */

interface Options {
  config: SimConfig;
  runs: number;
  out: string | null;
  sweep: { path: string; values: string[] } | null;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** A copy of `config` with the dotted `key` (e.g. `trading.size`) set to `raw`, parsed as JSON when it can be. */
function withValue(config: SimConfig, key: string, raw: string): SimConfig {
  const copy = structuredClone(config) as unknown as Record<string, unknown>;
  const parts = key.split(".");
  let target = copy;
  for (const part of parts.slice(0, -1)) {
    if (typeof target[part] !== "object" || target[part] === null) throw new Error(`Unknown setting ${key}`);
    target = target[part] as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (!(last in target)) throw new Error(`Unknown setting ${key}`);
  target[last] = parseValue(raw);
  return copy as unknown as SimConfig;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { config: structuredClone(DEFAULT_SIM_CONFIG), runs: 1, out: "sim-out", sweep: null };
  const args = argv.filter((arg) => arg !== "--");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => {
      const next = args[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--seed") options.config.seed = parseValue(value()) as string | number;
    else if (arg === "--runs") options.runs = Number(value());
    else if (arg === "--weeks") options.config.weeks = Number(value());
    else if (arg === "--listings") options.config.listings = Number(value());
    else if (arg === "--tick") options.config.tickSeconds = Number(value());
    else if (arg === "--out") options.out = value();
    else if (arg === "--no-csv") options.out = null;
    else if (arg === "--set") {
      const [key, raw] = value().split("=");
      options.config = withValue(options.config, key!, raw ?? "");
    } else if (arg === "--sweep") {
      const [key, raw] = value().split("=");
      options.sweep = { path: key!, values: (raw ?? "").split(",") };
    } else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const shareLine = (shares: Sources) => `events ${pct(shares.events).padStart(6)}  trades ${pct(shares.trades).padStart(6)}  noise ${pct(shares.noise).padStart(6)}`;
const SPARKS = "▁▂▃▄▅▆▇█";

function sparkline(values: number[]): string {
  const low = Math.min(...values), high = Math.max(...values);
  return values.map((value) => SPARKS[high === low ? 3 : Math.round(((value - low) / (high - low)) * (SPARKS.length - 1))]).join("");
}

function seeds(config: SimConfig, runs: number): SimConfig[] {
  const base = typeof config.seed === "number" ? config.seed : 0;
  return Array.from({ length: runs }, (_, i) => ({ ...config, seed: typeof config.seed === "number" ? base + i : `${config.seed}:${i}` }));
}

function meanShares(results: SeasonResult[], pick: (result: SeasonResult) => Sources): { mean: Sources; sd: Sources } {
  const keys = ["events", "trades", "noise"] as const;
  const mean = { events: 0, trades: 0, noise: 0 }, sd = { events: 0, trades: 0, noise: 0 };
  for (const key of keys) {
    const values = results.map((result) => pick(result)[key]);
    mean[key] = values.reduce((sum, value) => sum + value, 0) / values.length;
    sd[key] = Math.sqrt(values.reduce((sum, value) => sum + (value - mean[key]) ** 2, 0) / Math.max(1, values.length - 1));
  }
  return { mean, sd };
}

function writeCsv(dir: string, name: string, header: string[], rows: Array<Array<string | number>>): void {
  writeFileSync(path.join(dir, name), [header.join(","), ...rows.map((row) => row.join(","))].join("\n") + "\n");
}

function writeOutputs(dir: string, result: SeasonResult): void {
  mkdirSync(dir, { recursive: true });
  const f = (value: number, dp = 4) => value.toFixed(dp);
  writeCsv(dir, "summary.csv", ["ticker", "personality", "rulings", "trades", "final_price", "season_return", "high", "low", "share_events", "share_trades", "share_noise"],
    result.listings.map((l) => [l.ticker, f(l.personality, 3), l.rulings, l.trades, f(l.finalPrice, 2), f(l.seasonReturn), f(l.high, 2), f(l.low, 2), f(l.shares.events), f(l.shares.trades), f(l.shares.noise)]));
  writeCsv(dir, "daily.csv", ["day", "ticker", "close", "fair", "d_events", "d_trades", "d_noise"],
    result.daily.map((d) => [d.day, d.listing, f(d.close, 2), f(d.fair, 2), f(d.events, 6), f(d.trades, 6), f(d.noise, 6)]));
  writeCsv(dir, "hourly.csv", ["hour", "ticker", "price", "fair"], result.hourly.map((h) => [h.hour, h.listing, f(h.price, 2), f(h.fair, 2)]));
  writeCsv(dir, "events.csv", ["at_seconds", "ticker", "kind", "impact", "move", "queued"],
    result.events.map((e) => [e.at, e.listing, e.kind, f(e.impact, 1), f(e.move, 6), e.queued ? 1 : 0]));
}

function report(options: Options, results: SeasonResult[], seconds: number): void {
  const { config } = options;
  const first = results[0]!;
  console.log(`Aura Exchange season simulator · seed ${String(config.seed)}${results.length > 1 ? ` (+${results.length - 1} more)` : ""} · ${config.listings} listings · ${config.weeks} weeks · ${config.tickSeconds} s ticks · ${seconds.toFixed(1)} s`);
  console.log("");
  const daily = meanShares(results, (r) => r.shares.daily);
  console.log(`Share of movement, Σ|Δ| per trading day:  ${shareLine(daily.mean)}   (target 60 / 25 / 15)`);
  if (results.length > 1) console.log(`  sd across ${results.length} seasons:                ${shareLine(daily.sd)}`);
  console.log(`  per hour:                                ${shareLine(meanShares(results, (r) => r.shares.hourly).mean)}`);
  console.log(`  per week:                                ${shareLine(meanShares(results, (r) => r.shares.weekly).mean)}`);
  console.log(`  daily Σ Δ²:                              ${shareLine(meanShares(results, (r) => r.shares.dailyVariance).mean)}`);
  console.log("");
  const days = config.weeks * 7;
  const rulings = first.listings.reduce((sum, l) => sum + l.rulings, 0);
  const kinds = (kind: string) => first.events.filter((e) => e.kind === kind).length;
  console.log(`First season: ${rulings} rulings (${(rulings / config.listings / days).toFixed(2)} per listing per day; ${kinds("VOIDED")} voided by vote, ${first.events.filter((e) => e.queued).length} news items queued for the open), ${kinds("EARNINGS")} earnings reports`);
  console.log(`  ${first.trades.count} trades (${(first.trades.count / config.listings / days).toFixed(1)} per player per day), A$${Math.round(first.trades.volume).toLocaleString("en-US")} traded, ${first.trades.liquidations} liquidations; booking residual ${first.residual.toExponential(1)}`);
  console.log("");
  console.log("Ticker  pers  rulings  trades   final  return    high     low   events trades  noise   daily closes");
  for (const l of first.listings) {
    const closes = first.daily.filter((d) => d.listing === l.ticker).map((d) => d.close);
    console.log(`${l.ticker.padEnd(6)} ${l.personality.toFixed(2).padStart(5)} ${String(l.rulings).padStart(8)} ${String(l.trades).padStart(7)} ${l.finalPrice.toFixed(2).padStart(7)} ${pct(l.seasonReturn).padStart(7)} ${l.high.toFixed(2).padStart(7)} ${l.low.toFixed(2).padStart(7)}   ${pct(l.shares.events).padStart(6)} ${pct(l.shares.trades).padStart(6)} ${pct(l.shares.noise).padStart(6)}   ${sparkline(closes)}`);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.sweep) {
    const { path: key, values } = options.sweep;
    console.log(`Sweep of ${key} · ${options.runs} season(s) each · daily Σ|Δ| shares (target 60 / 25 / 15)`);
    for (const raw of values) {
      const results = seeds(withValue(options.config, key, raw), options.runs).map(runSeason);
      const trades = results.reduce((sum, r) => sum + r.trades.count, 0) / results.length;
      console.log(`  ${raw.padStart(8)}   ${shareLine(meanShares(results, (r) => r.shares.daily).mean)}   ${Math.round(trades)} trades/season`);
    }
    return;
  }
  const started = performance.now();
  const results = seeds(options.config, options.runs).map(runSeason);
  report(options, results, (performance.now() - started) / 1000);
  if (options.out) {
    writeOutputs(options.out, results[0]!);
    console.log(`\nCSVs for the first season: ${options.out}/summary.csv, daily.csv, hourly.csv, events.csv`);
  }
}

main();
