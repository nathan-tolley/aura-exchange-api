import { LOGIN_CODE_TTL_MINUTES } from "./login-code-service.js";

/** Delivers sign-in codes: Resend in production (DECISIONS.md open question 8), the log in development and tests. */
export interface EmailSender {
  sendLoginCode(email: string, code: string): Promise<void>;
}

export type LogLine = (fields: Record<string, unknown>, message: string) => void;

/** Development sender: prints the code to the server log instead of emailing it. */
export class LogEmailSender implements EmailSender {
  constructor(private readonly log: LogLine) {}

  async sendLoginCode(email: string, code: string): Promise<void> {
    this.log({ email, code }, "auth.login_code (development: not emailed)");
  }
}

/** A provider refused or never answered. The message never contains the code or the address. */
export class EmailDeliveryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

export interface LoginCodeEmail {
  subject: string;
  text: string;
  html: string;
}

/** The sign-in email, in the app's voice: plain, exact, no exclamation marks. */
export function loginCodeEmail(code: string): LoginCodeEmail {
  if (!/^\d{6}$/.test(code)) throw new Error("A sign-in code is 6 digits");
  const expiry = `It expires in ${LOGIN_CODE_TTL_MINUTES} minutes.`;
  const ignore = "If you didn't ask for a code, you can ignore this email.";
  return {
    subject: `${code} is your Aura Exchange code`,
    text: [`Your Aura Exchange sign-in code is ${code}.`, "", expiry, "", ignore, ""].join("\n"),
    html: [
      "<!doctype html>",
      '<html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#111;">',
      '<p style="margin:0 0 12px;">Your Aura Exchange sign-in code is</p>',
      `<p style="margin:0 0 20px;font-size:32px;letter-spacing:6px;font-family:Menlo,Consolas,monospace;">${code}</p>`,
      `<p style="margin:0 0 12px;">${expiry}</p>`,
      `<p style="margin:0;color:#555;">${ignore.replace("'", "&#39;")}</p>`,
      "</body></html>"
    ].join("\n")
  };
}

export interface ResendOptions {
  apiKey: string;
  /** A sender on a domain verified in Resend, e.g. `Aura Exchange <codes@example.com>`. */
  from: string;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

/** Sends sign-in codes through Resend's HTTP API (POST /emails). */
export class ResendEmailSender implements EmailSender {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly options: ResendOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.baseUrl = options.baseUrl ?? "https://api.resend.com";
  }

  async sendLoginCode(email: string, code: string): Promise<void> {
    const message = loginCodeEmail(code);
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          "user-agent": "aura-exchange-api"
        },
        body: JSON.stringify({ from: this.options.from, to: [email], subject: message.subject, text: message.text, html: message.html }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      // A timeout or a network failure. Only the error's kind is kept: some runtimes echo the request in the message.
      throw new EmailDeliveryError(`Resend did not answer (${error instanceof Error ? error.name : "Error"})`);
    }
    if (!response.ok) {
      const detail = await resendErrorDetail(response, [code, email]);
      throw new EmailDeliveryError(`Resend answered ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
  }
}

/** Resend's `{ name, message }` error body, trimmed, with anything we sent it scrubbed out. */
async function resendErrorDetail(response: Response, secrets: string[]): Promise<string> {
  let detail = "";
  try {
    const body = await response.json() as { name?: unknown; message?: unknown };
    detail = [body.name, body.message].filter((part) => typeof part === "string" && part).join(": ");
  } catch {
    return "";
  }
  for (const secret of secrets) detail = detail.split(secret).join("[redacted]");
  return detail.slice(0, 200);
}

export interface EmailSenderConfig {
  EMAIL_PROVIDER: "log" | "resend";
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

/** The sender the environment asks for. `config.ts` has already refused `resend` without a key and a from address. */
export function emailSenderFromConfig(env: EmailSenderConfig, log: LogLine): EmailSender {
  if (env.EMAIL_PROVIDER === "resend") {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("EMAIL_PROVIDER=resend needs RESEND_API_KEY and EMAIL_FROM");
    return new ResendEmailSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
  }
  return new LogEmailSender(log);
}
