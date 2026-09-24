"use client";

/**
 * Observer web portal login (R28.1, R28.2).
 *
 * OTP to the registered phone number is the primary channel. The
 * Web_Crypto_Vault key pair is restored/created locally and only its PUBLIC
 * key PEM is transmitted on verify — the private key never leaves the browser
 * (R28.2). Passkey (WebAuthn) enrollment is offered after sign-in as an
 * optional second factor for subsequent logins.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError } from "../../../lib/api-client";
import { beginOtpLogin, completeOtpLogin } from "../../../lib/auth-flow";

type Phase = "phone" | "code";

export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("phone");
  const [phone, setPhone] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRequest(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = await beginOtpLogin(phone.trim());
      setChallengeId(id);
      setPhase("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await completeOtpLogin(challengeId, code.trim());
      router.replace("/dashboard");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "That code didn't work.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">Welcome back</h1>
      <p className="mt-2 text-typography/70">
        Sign in to your Observer portal.
      </p>

      {phase === "phone" ? (
        <form onSubmit={onRequest} className="mt-8 flex flex-col gap-4">
          <label className="text-sm font-medium" htmlFor="phone">
            Registered phone number
          </label>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="rounded-lg border border-typography/20 px-3 py-2"
            placeholder="+91 90000 00000"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-primary-action px-6 py-3 font-medium text-white disabled:opacity-60"
          >
            {busy ? "Sending…" : "Send me a one-time code"}
          </button>
        </form>
      ) : (
        <form onSubmit={onVerify} className="mt-8 flex flex-col gap-4">
          <label className="text-sm font-medium" htmlFor="code">
            Enter the code we sent
          </label>
          <input
            id="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="rounded-lg border border-typography/20 px-3 py-2 tracking-widest"
            placeholder="123456"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-primary-action px-6 py-3 font-medium text-white disabled:opacity-60"
          >
            {busy ? "Verifying…" : "Continue"}
          </button>
          <button
            type="button"
            onClick={() => setPhase("phone")}
            className="text-sm text-typography/60"
          >
            Use a different number
          </button>
        </form>
      )}

      {error ? (
        <p role="alert" className="mt-4 text-sm text-primary-action">
          {error}
        </p>
      ) : null}

      <p className="mt-8 text-xs text-typography/50">
        Your private key is generated and kept on this device only. It is never
        sent to Kshema.
      </p>
    </main>
  );
}
