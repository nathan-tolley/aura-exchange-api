import { describe, expect, it } from "vitest";
import { DEFAULT_HOURS, isValidTimeZone, marketSession, validateHours } from "../src/core/market-hours.js";

const NY = "America/New_York";
const at = (iso: string) => marketSession(DEFAULT_HOURS, NY, new Date(iso));

describe("market sessions (default hours, New York, EDT = UTC−4)", () => {
  it("is open from 9 am to 10 pm and says when it closes", () => {
    expect(at("2026-10-24T16:00:00Z")).toEqual({
      state: "OPEN", nextChangeAt: new Date("2026-10-25T02:00:00Z"), opensAt: new Date("2026-10-25T11:00:00Z")
    });
  });

  it("runs pre-market 7–9 am and after-hours 10 pm–2 am across midnight", () => {
    expect(at("2026-10-24T11:00:00Z").state).toBe("PRE");
    expect(at("2026-10-24T12:59:59Z").state).toBe("PRE");
    expect(at("2026-10-24T13:00:00Z").state).toBe("OPEN");
    expect(at("2026-10-25T02:00:00Z").state).toBe("AFTER");
    expect(at("2026-10-25T05:59:00Z")).toMatchObject({ state: "AFTER", nextChangeAt: new Date("2026-10-25T06:00:00Z") });
  });

  it("is closed 2–7 am, reopening at pre-market", () => {
    expect(at("2026-10-25T06:00:00Z")).toEqual({
      state: "CLOSED", nextChangeAt: new Date("2026-10-25T11:00:00Z"), opensAt: new Date("2026-10-25T11:00:00Z")
    });
  });

  it("uses each exchange's own timezone", () => {
    expect(marketSession(DEFAULT_HOURS, "Pacific/Honolulu", new Date("2026-10-24T16:00:00Z")).state).toBe("CLOSED");
    expect(marketSession(DEFAULT_HOURS, "Europe/London", new Date("2026-10-24T16:00:00Z")).state).toBe("OPEN");
  });

  it("validates hours and timezones", () => {
    expect(validateHours(DEFAULT_HOURS)).toBe(true);
    expect(validateHours({ preOpen: "09:00", open: "07:00", close: "22:00", afterClose: "02:00" })).toBe(false);
    expect(validateHours({ preOpen: "07:00", open: "09:00", close: "22:00", afterClose: "07:00" })).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});
