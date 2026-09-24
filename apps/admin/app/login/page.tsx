"use client";

/**
 * Admin console sign-in (R21.1).
 *
 * Admin operators authenticate through the organisation's MFA/SSO provider,
 * which issues a signed admin token carrying the admin id, the single role, and
 * an `mfa` claim. The console accepts that token here, decodes its claims for
 * UI gating, and stores it for the tab. The Fastify `AdminAuthGuard`
 * independently verifies the signature and MFA on every request, so a token
 * that is unsigned, expired, or missing the MFA claim gets no access even if it
 * is pasted here. A token whose `mfa` claim is not satisfied is refused at this
 * screen with a clear message.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { decodeAdminToken, setSession } from "../../lib/session";

export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setError(null);

    const session = decodeAdminToken(token);
    if (!session) {
      setError(
        "That admin token is not valid or has expired. Sign in again through your identity provider.",
      );
      return;
    }
    if (!session.mfa) {
      setError(
        "Multi-factor authentication is required for the console. Complete MFA and try again.",
      );
      return;
    }

    setSession(session);
    router.replace("/");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">Kshema Operations Console</h1>
      <p className="mt-2 text-typography/70">
        Sign in with the admin token issued by your identity provider after
        completing multi-factor authentication.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
        <label className="text-sm font-medium" htmlFor="admin-token">
          Admin session token
        </label>
        <textarea
          id="admin-token"
          required
          rows={4}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="rounded-lg border border-typography/20 px-3 py-2 font-mono text-xs"
          placeholder="eyJhbGciOi…"
        />
        <button
          type="submit"
          className="rounded-full bg-primary-action px-6 py-3 font-medium text-white"
        >
          Enter the console
        </button>
      </form>

      {error ? (
        <p role="alert" className="mt-4 text-sm text-primary-action">
          {error}
        </p>
      ) : null}

      <p className="mt-8 text-xs text-typography/50">
        This console cannot decrypt Flight Recorder contents or view live
        location or audio for any Anchor, regardless of role.
      </p>
    </main>
  );
}
