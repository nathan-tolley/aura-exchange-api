export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "APP_ERROR",
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST", details?: unknown) =>
  new AppError(400, message, code, details);
export const unauthorized = (message = "Sign in required") => new AppError(401, message, "UNAUTHORIZED");
export const forbidden = (message = "You do not have permission") => new AppError(403, message, "FORBIDDEN");
export const notFound = (message = "Not found") => new AppError(404, message, "NOT_FOUND");
export const conflict = (message: string, code = "CONFLICT") => new AppError(409, message, code);

