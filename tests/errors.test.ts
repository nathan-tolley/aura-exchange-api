import { describe, expect, it } from "vitest";
import { z } from "zod";
import { appError, badRequest, errorBody, errorCodes, forbidden, notFound, toContractError } from "../src/errors.js";

const context = { reference: "req-1" };

describe("contract errors", () => {
  it("takes status, action and retryable from the contract table", () => {
    const error = appError("INSUFFICIENT_CASH", { needed: "2494.41", available: "2264.50", shortBy: "229.91", maxQuantity: "18" });
    expect(error.statusCode).toBe(422);
    expect(error.action).toBe("REDUCE_QUANTITY");
    expect(error.retryable).toBe(false);
    expect(appError("QUOTE_STALE")).toMatchObject({ statusCode: 409, action: "REQUOTE", retryable: true });
    expect(appError("UPDATE_REQUIRED")).toMatchObject({ statusCode: 426, action: "UPDATE_APP" });
  });

  it("serializes to the one error shape", () => {
    const body = errorBody(appError("NOT_A_MEMBER", { exchangeId: "x" }, "Not a member"));
    expect(body).toEqual({ error: { code: "NOT_A_MEMBER", message: "Not a member", params: { exchangeId: "x" }, retryable: false, action: "NONE" } });
  });

  it("maps zod failures to VALIDATION with the field and rule", () => {
    const parsed = z.object({ quantity: z.number().positive() }).safeParse({ quantity: -1 });
    const error = toContractError(parsed.error, context);
    expect(error.code).toBe("VALIDATION");
    expect(error.statusCode).toBe(400);
    expect(error.params).toEqual({ field: "quantity", rule: "too_small" });
  });

  it("translates legacy codes thrown by shared code", () => {
    expect(toContractError(badRequest("Insufficient Aura Credits", "INSUFFICIENT_FUNDS"), context)).toMatchObject({ code: "INSUFFICIENT_CASH", statusCode: 422 });
    expect(toContractError(badRequest("Market moved", "STALE_QUOTE"), context)).toMatchObject({ code: "QUOTE_STALE", action: "REQUOTE" });
    expect(toContractError(forbidden(), context)).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(toContractError(notFound("Quote not found"), context)).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(toContractError(badRequest("You do not own enough shares", "INSUFFICIENT_SHARES"), context))
      .toMatchObject({ code: "INSUFFICIENT_SHARES", statusCode: 422 });
    expect(toContractError(badRequest("Some shares are reserved", "SHARES_RESERVED"), context))
      .toMatchObject({ code: "VALIDATION", params: { field: "body", rule: "shares_reserved" } });
  });

  it("keeps the contract's status even if a contract code was thrown with another", () => {
    expect(toContractError(badRequest("Too big", "ORDER_TOO_LARGE"), context)).toMatchObject({ code: "ORDER_TOO_LARGE", statusCode: 422 });
  });

  it("turns rate-limit rejections into RATE_LIMITED with retryAfterSeconds", () => {
    const error = toContractError(Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 }), { ...context, retryAfter: "30" });
    expect(error).toMatchObject({ code: "RATE_LIMITED", statusCode: 429, retryable: true, params: { retryAfterSeconds: "30" } });
  });

  it("hides unknown failures behind SERVER with a reference", () => {
    const error = toContractError(new Error("connection refused"), context);
    expect(error).toMatchObject({ code: "SERVER", statusCode: 500, retryable: true, action: "RETRY", params: { reference: "req-1" } });
    expect(error.message).not.toContain("connection refused");
  });

  it("only ever emits string params", () => {
    for (const code of Object.keys(errorCodes) as Array<keyof typeof errorCodes>) {
      const error = toContractError(appError(code, { a: "1" }), context);
      expect(Object.values(error.params).every((value) => typeof value === "string")).toBe(true);
    }
  });
});
