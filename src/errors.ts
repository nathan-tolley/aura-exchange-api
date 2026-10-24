import { ZodError } from "zod";

export type ErrorAction =
  | "RETRY" | "REQUOTE" | "REDUCE_QUANTITY" | "SELL_SOMETHING" | "WAIT" | "SIGN_IN" | "UPDATE_APP" | "CONTACT_ADMIN" | "NONE";

/** Error params are always strings, formatted like the contract's numbers. */
export type ErrorParams = Record<string, string>;

interface ErrorDefaults {
  status: number;
  action: ErrorAction;
  retryable: boolean;
}

/** The /v1 error codes. Status, action and retryable are the contract's (docs/aura/API-CONTRACT.md → One error shape). */
export const errorCodes = {
  VALIDATION: { status: 400, action: "NONE", retryable: false },
  AUTH_EXPIRED: { status: 401, action: "SIGN_IN", retryable: false },
  FORBIDDEN: { status: 403, action: "NONE", retryable: false },
  NOT_A_MEMBER: { status: 403, action: "NONE", retryable: false },
  SELF_TRADE: { status: 403, action: "NONE", retryable: false },
  NOT_FOUND: { status: 404, action: "NONE", retryable: false },
  CONFLICT: { status: 409, action: "NONE", retryable: false },
  QUOTE_STALE: { status: 409, action: "REQUOTE", retryable: true },
  IDEMPOTENCY_MISMATCH: { status: 409, action: "NONE", retryable: false },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, action: "RETRY", retryable: true },
  LISTING_HALTED: { status: 409, action: "WAIT", retryable: false },
  MARKET_CLOSED: { status: 409, action: "WAIT", retryable: false },
  ORDER_TYPE_NOT_ALLOWED: { status: 409, action: "NONE", retryable: false },
  INSUFFICIENT_CASH: { status: 422, action: "REDUCE_QUANTITY", retryable: false },
  ORDER_TOO_LARGE: { status: 422, action: "REDUCE_QUANTITY", retryable: false },
  SHORT_CAP: { status: 422, action: "REDUCE_QUANTITY", retryable: false },
  OPPOSITE_POSITION: { status: 422, action: "NONE", retryable: false },
  EQUITY_TOO_LOW: { status: 422, action: "NONE", retryable: false },
  DAILY_FILING_LIMIT: { status: 422, action: "WAIT", retryable: false },
  UNSEND_EXPIRED: { status: 422, action: "NONE", retryable: false },
  UPDATE_REQUIRED: { status: 426, action: "UPDATE_APP", retryable: false },
  RATE_LIMITED: { status: 429, action: "WAIT", retryable: true },
  SERVER: { status: 500, action: "RETRY", retryable: true },
  MAINTENANCE: { status: 503, action: "RETRY", retryable: true }
} as const satisfies Record<string, ErrorDefaults>;

export type ErrorCode = keyof typeof errorCodes;

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    public readonly params: ErrorParams = {},
    public readonly action: ErrorAction = "NONE",
    public readonly retryable = false,
    message: string = code,
    /** Legacy /api detail payload; never sent on /v1. */
    public readonly details?: unknown
  ) {
    super(message);
  }
}

/** A /v1 error with the contract's status, action and retryable for its code. */
export function appError(code: ErrorCode, params: ErrorParams = {}, message?: string): AppError {
  const defaults: ErrorDefaults = errorCodes[code];
  return new AppError(code, defaults.status, params, defaults.action, defaults.retryable, message ?? code);
}

// Legacy /api helpers. Their codes are translated by toContractError when they surface on /v1.
export const badRequest = (message: string, code = "BAD_REQUEST", details?: unknown) =>
  new AppError(code, 400, {}, "NONE", false, message, details);
export const unauthorized = (message = "Sign in required") => new AppError("UNAUTHORIZED", 401, {}, "SIGN_IN", false, message);
export const forbidden = (message = "You do not have permission") => new AppError("FORBIDDEN", 403, {}, "NONE", false, message);
export const notFound = (message = "Not found") => new AppError("NOT_FOUND", 404, {}, "NONE", false, message);
export const conflict = (message: string, code = "CONFLICT") => new AppError(code, 409, {}, "NONE", false, message);

/** Legacy codes thrown by shared code, and the contract code each one means on /v1. */
const legacyCodes: Record<string, ErrorCode> = {
  BAD_REQUEST: "VALIDATION",
  VALIDATION_ERROR: "VALIDATION",
  INVALID_QUANTITY: "VALIDATION",
  UNAUTHORIZED: "AUTH_EXPIRED",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_CASH",
  STALE_QUOTE: "QUOTE_STALE",
  QUOTE_EXPIRED: "QUOTE_STALE",
  QUOTE_USED: "QUOTE_STALE",
  MARKET_HALTED: "LISTING_HALTED"
};

const fallbackByStatus: Record<number, ErrorCode> = {
  401: "AUTH_EXPIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  426: "UPDATE_REQUIRED",
  429: "RATE_LIMITED",
  503: "MAINTENANCE"
};

export interface ContractErrorContext {
  /** Request id, returned as `reference` on SERVER errors. */
  reference: string;
  /** The Retry-After header, set by the rate limiter. */
  retryAfter?: unknown;
}

/** Turns anything thrown under /v1 into a contract error. */
export function toContractError(error: unknown, context: ContractErrorContext): AppError {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return appError("VALIDATION", { field: issue?.path.join(".") || "body", rule: issue?.code ?? "invalid" }, "Invalid request");
  }
  if (error instanceof AppError) {
    if (error.code in errorCodes) {
      const defaults: ErrorDefaults = errorCodes[error.code as ErrorCode];
      return new AppError(error.code, defaults.status, error.params, defaults.action, defaults.retryable, error.message);
    }
    const mapped = legacyCodes[error.code] ?? fallbackByStatus[error.statusCode];
    if (mapped) return appError(mapped, mapped === "VALIDATION" ? { field: "body", rule: error.code.toLowerCase() } : {}, error.message);
    if (error.statusCode < 500) return appError("VALIDATION", { field: "body", rule: error.code.toLowerCase() }, error.message);
  }
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    if (status === 429) {
      const seconds = Number(context.retryAfter);
      return appError("RATE_LIMITED", { retryAfterSeconds: String(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60) }, "Too many requests");
    }
    const mapped = fallbackByStatus[status];
    if (mapped) return appError(mapped, {}, (error as Error).message);
    const rule = String((error as { code?: unknown }).code ?? "invalid").toLowerCase();
    return appError("VALIDATION", { field: "body", rule }, (error as Error).message);
  }
  if ((error as { code?: unknown }).code === "23505") return appError("CONFLICT", {}, "That value already exists");
  return appError("SERVER", { reference: context.reference }, "Something went wrong on the server");
}

/** The contract body for a /v1 error. */
export function errorBody(error: AppError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      params: error.params,
      retryable: error.retryable,
      action: error.action
    }
  };
}
