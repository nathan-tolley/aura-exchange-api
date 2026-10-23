import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { BoltIcon, ShieldIcon, SparkIcon } from "../icons";

type Mode = "login" | "claim" | "reset" | "setup";

export function AuthScreen({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
  const [mode, setMode] = useState<Mode>("login");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean }>("/api/setup/status").then(({ needsSetup }) => {
      setNeedsSetup(needsSetup);
      if (needsSetup) setMode("setup");
    }).catch(() => setError("The exchange server is not responding."));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (mode === "login") {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: data.username, password: data.password }) });
      } else if (mode === "claim") {
        await api("/api/auth/claim", { method: "POST", body: JSON.stringify({
          claimCode: data.claimCode, username: data.username, password: data.password, consent: true
        }) });
      } else if (mode === "reset") {
        await api("/api/auth/reset", { method: "POST", body: JSON.stringify({ username: data.username, resetCode: data.resetCode, newPassword: data.password }) });
        setMode("login"); setError("Password updated. Sign in with the new password."); return;
      } else {
        await api("/api/setup/bootstrap", { method: "POST", body: JSON.stringify({
          setupToken: data.setupToken, displayName: data.displayName, ticker: data.ticker,
          username: data.username, password: data.password, consent: true
        }) });
      }
      await onAuthenticated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not enter the exchange");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="brand brand-large"><span className="brand-mark"><BoltIcon /></span><span>AURA<br/><b>EXCHANGE</b></span></div>
        <div className="auth-copy">
          <p className="eyebrow">THE OFFICE HAS A MARKET NOW</p>
          <h1>Trade reputation.<br/><em>Short the cringe.</em></h1>
          <p>Every story moves the Aura Composite. Every trade says what you think happens next.</p>
        </div>
        <div className="auth-features">
          <span><SparkIcon /> AI-judged aura</span>
          <span><ShieldIcon /> Invite-only</span>
          <span><BoltIcon /> Play money, real lore</span>
        </div>
        <p className="auth-disclaimer">Fictional entertainment only. Never a measure of job performance or factual truth.</p>
      </section>

      <section className="auth-panel-wrap">
        <div className="auth-panel">
          <div className="auth-tabs" role="tablist">
            {!needsSetup && <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>}
            {!needsSetup && <button className={mode === "claim" ? "active" : ""} onClick={() => setMode("claim")}>Claim stock</button>}
            {needsSetup && <button className="active">Open exchange</button>}
          </div>
          <div className="auth-heading">
            <p className="eyebrow">{mode === "setup" ? "FIRST-RUN SETUP" : mode === "claim" ? "WELCOME TO THE FLOOR" : "MARKET ACCESS"}</p>
            <h2>{mode === "setup" ? "Create the first listing" : mode === "claim" ? "Claim your ticker" : "The bell is ringing"}</h2>
            <p>{mode === "setup" ? "Use the setup token from your .env file." : mode === "claim" ? "Your admin gave you a one-time claim code." : "Sign in to see the tape."}</p>
          </div>
          <form onSubmit={submit} className="auth-form">
            {mode === "setup" && <>
              <label>Setup token<input name="setupToken" type="password" required autoComplete="off" /></label>
              <div className="field-row">
                <label>Display name<input name="displayName" required maxLength={60} /></label>
                <label>Ticker<input name="ticker" required minLength={3} maxLength={5} placeholder="AURA" /></label>
              </div>
            </>}
            {mode === "claim" && <label>Claim code<input name="claimCode" required autoCapitalize="characters" autoComplete="off" /></label>}
            {mode === "reset" && <label>Reset code<input name="resetCode" required autoCapitalize="characters" autoComplete="off" /></label>}
            <label>Username<input name="username" required minLength={3} maxLength={32} autoComplete="username" /></label>
            <label>Password<input name="password" type="password" required minLength={10} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
            {mode === "claim" || mode === "setup" ? <p className="consent-note"><span>✓</span> By continuing, you consent to having an Aura stock and understand this is a private play-money game.</p> : null}
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="button primary full" disabled={busy}>{busy ? "Opening…" : mode === "login" ? "Enter exchange" : mode === "claim" ? "Claim & enter" : mode === "reset" ? "Set new password" : "Open Aura Exchange"}</button>
            {mode === "login" && <button type="button" className="text-button" onClick={() => setMode("reset")}>Have an admin reset code?</button>}
            {mode === "reset" && <button type="button" className="text-button" onClick={() => setMode("login")}>Back to sign in</button>}
          </form>
        </div>
      </section>
    </main>
  );
}

