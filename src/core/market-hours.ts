/** Market sessions per exchange, in the exchange's own timezone (PLAN.md → Market hours). Pure. */

export type MarketState = "PRE" | "OPEN" | "AFTER" | "CLOSED" | "HALTED";

/** Local wall-clock times, "HH:MM". After-hours may run past midnight (the default closes at 02:00). */
export interface MarketHours {
  preOpen: string;
  open: string;
  close: string;
  afterClose: string;
}

export const DEFAULT_HOURS: MarketHours = { preOpen: "07:00", open: "09:00", close: "22:00", afterClose: "02:00" };

export interface Session {
  state: Exclude<MarketState, "HALTED">;
  /** When the state next changes. */
  nextChangeAt: Date;
  /** When pre-market next opens (the end of the current or next closed period). */
  opensAt: Date;
}

const DAY = 24 * 60;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isValidTime = (value: string) => HHMM.test(value);

function minutesOf(value: string): number {
  const match = HHMM.exec(value);
  if (!match) throw new Error(`Invalid time ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The four boundaries as minutes after pre-open, in order; rejects hours that don't run pre → open → close → after. */
function offsets(hours: MarketHours): { open: number; close: number; afterClose: number } {
  const start = minutesOf(hours.preOpen);
  const after = (time: string) => (minutesOf(time) - start + DAY) % DAY;
  const open = after(hours.open);
  const close = after(hours.close);
  const afterClose = after(hours.afterClose) || DAY;
  if (!(open > 0 && close > open && afterClose >= close)) throw new Error("Hours must run pre-open → open → close → after-close within a day");
  return { open, close, afterClose };
}

export function validateHours(hours: MarketHours): boolean {
  try {
    offsets(hours);
    return true;
  } catch {
    return false;
  }
}

/** Minutes (with fraction) since midnight, local to the timezone. */
function localMinutes(timeZone: string, now: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute) + (Number(parts.second) + now.getUTCMilliseconds() / 1000) / 60;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The session at `now`. Boundaries are found by walking forward in minutes from now, so on the two days a year
 * the clocks change, the next boundary can be an hour off.
 */
export function marketSession(hours: MarketHours, timeZone: string, now: Date): Session {
  const bounds = offsets(hours);
  const sincePreOpen = (localMinutes(timeZone, now) - minutesOf(hours.preOpen) + DAY) % DAY;
  const at = (offset: number) => new Date(Math.round((now.getTime() + (offset - sincePreOpen) * 60_000) / 1000) * 1000);
  const opensAt = at(DAY);
  if (sincePreOpen < bounds.open) return { state: "PRE", nextChangeAt: at(bounds.open), opensAt };
  if (sincePreOpen < bounds.close) return { state: "OPEN", nextChangeAt: at(bounds.close), opensAt };
  if (sincePreOpen < bounds.afterClose) return { state: "AFTER", nextChangeAt: at(bounds.afterClose), opensAt };
  return { state: "CLOSED", nextChangeAt: opensAt, opensAt };
}

/** PLAN.md → Economy: the weekly allowance (the "stimulus check") and dividends pay on Mondays from 9 am, local time. */
export const WEEKLY_PAYOUT = { weekday: 1, hour: 9 } as const;

/** The local calendar date (as a UTC midnight), weekday (0 = Sunday) and hour in a timezone. */
function localCalendar(timeZone: string, now: Date): { date: number; weekday: number; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const date = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return { date, weekday: new Date(date).getUTCDay(), hour: Number(parts.hour) };
}

/** How far the timezone's clock is ahead of UTC at `instant`, in ms. */
function zoneOffset(timeZone: string, instant: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant a local wall-clock time (`localWall`, as if it were UTC) happens in the timezone. */
function zonedInstant(timeZone: string, localWall: number): Date {
  const first = localWall - zoneOffset(timeZone, localWall);
  return new Date(localWall - zoneOffset(timeZone, first));
}

export function weeklyPayoutDue(timeZone: string, now: Date): boolean {
  const local = localCalendar(timeZone, now);
  return local.weekday === WEEKLY_PAYOUT.weekday && local.hour >= WEEKLY_PAYOUT.hour;
}

/** When the next weekly payout starts: this Monday's if it's still before 9 am, otherwise next Monday's. Exact across clock changes. */
export function nextWeeklyPayoutAt(timeZone: string, now: Date): Date {
  const local = localCalendar(timeZone, now);
  const daysAhead = (WEEKLY_PAYOUT.weekday - local.weekday + 7) % 7;
  const at = (days: number) => zonedInstant(timeZone, local.date + days * DAY * 60_000 + WEEKLY_PAYOUT.hour * 3_600_000);
  const candidate = at(daysAhead);
  return candidate > now ? candidate : at(daysAhead + 7);
}
