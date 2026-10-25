/** Delivers sign-in codes. The real provider is DECISIONS.md open question 8; until then codes go to the log. */
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
