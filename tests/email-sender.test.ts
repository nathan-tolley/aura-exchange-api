import { describe, expect, it } from "vitest";
import { EmailDeliveryError, emailSenderFromConfig, LogEmailSender, loginCodeEmail, ResendEmailSender } from "../src/services/email-sender.js";

interface Sent {
  url: string;
  init: RequestInit;
}

/** A stand-in for Resend's HTTP API: records each request and answers with the given status and body. */
function fakeResend(status: number, body: unknown = { id: "email_123" }) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const sender = (fetch: typeof globalThis.fetch) =>
  new ResendEmailSender({ apiKey: "re_test_key", from: "Aura Exchange <codes@example.com>", fetch });

describe("the sign-in email", () => {
  it("says the code and the 10-minute expiry, plainly, with no exclamation marks", () => {
    const email = loginCodeEmail("042917");
    expect(email.subject).toBe("042917 is your Aura Exchange code");
    expect(email.text).toBe([
      "Your Aura Exchange sign-in code is 042917.",
      "",
      "It expires in 10 minutes.",
      "",
      "If you didn't ask for a code, you can ignore this email.",
      ""
    ].join("\n"));
    expect(email.html).toContain(">042917</p>");
    expect(email.html).toContain("It expires in 10 minutes.");
    const visibleHtml = email.html.replace(/<[^>]*>/g, "");
    for (const part of [email.subject, email.text, visibleHtml]) expect(part).not.toContain("!");
  });

  it("refuses anything but 6 digits, so nothing else can reach the HTML", () => {
    expect(() => loginCodeEmail("<b>1</b>")).toThrow();
  });
});

describe("ResendEmailSender", () => {
  it("posts one email to Resend with the key, the sender, the recipient, and plain text plus HTML", async () => {
    const resend = fakeResend(200);
    await sender(resend.fetch).sendLoginCode("nathan@example.com", "123456");

    expect(resend.sent).toHaveLength(1);
    const [request] = resend.sent;
    expect(request!.url).toBe("https://api.resend.com/emails");
    expect(request!.init.method).toBe("POST");
    expect(request!.init.headers).toMatchObject({ authorization: "Bearer re_test_key", "content-type": "application/json" });
    expect(request!.init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(request!.init.body));
    const expected = loginCodeEmail("123456");
    expect(body).toEqual({ from: "Aura Exchange <codes@example.com>", to: ["nathan@example.com"], subject: expected.subject, text: expected.text, html: expected.html });
  });

  it("turns a refusal into an EmailDeliveryError with the status, never repeating the code or the address", async () => {
    const resend = fakeResend(422, { name: "validation_error", message: "Cannot send 123456 to nathan@example.com" });
    const error = await sender(resend.fetch).sendLoginCode("nathan@example.com", "123456").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as EmailDeliveryError).status).toBe(422);
    expect((error as Error).message).toBe("Resend answered 422: validation_error: Cannot send [redacted] to [redacted]");
  });

  it("survives a refusal with no JSON body", async () => {
    const fetch = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof globalThis.fetch;
    const error = await sender(fetch).sendLoginCode("nathan@example.com", "123456").catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("Resend answered 502");
  });

  it("turns a timeout or network failure into an EmailDeliveryError with no status", async () => {
    const fetch = (async () => {
      throw new DOMException("POST https://api.resend.com/emails body 123456 timed out", "TimeoutError");
    }) as typeof globalThis.fetch;
    const error = await sender(fetch).sendLoginCode("nathan@example.com", "123456").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as EmailDeliveryError).status).toBeUndefined();
    expect((error as Error).message).toBe("Resend did not answer (TimeoutError)");
  });
});

describe("emailSenderFromConfig", () => {
  const log = () => {};

  it("logs codes by default", () => {
    expect(emailSenderFromConfig({ EMAIL_PROVIDER: "log" }, log)).toBeInstanceOf(LogEmailSender);
  });

  it("uses Resend when asked, and only with a key and a from address", () => {
    expect(emailSenderFromConfig({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", EMAIL_FROM: "a@example.com" }, log)).toBeInstanceOf(ResendEmailSender);
    expect(() => emailSenderFromConfig({ EMAIL_PROVIDER: "resend", EMAIL_FROM: "a@example.com" }, log)).toThrow(/RESEND_API_KEY/);
  });
});
