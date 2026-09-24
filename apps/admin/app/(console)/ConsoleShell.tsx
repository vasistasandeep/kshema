"use client";

/**
 * Authenticated admin console shell — the client-side `AdminAuthGuard` (R21.1).
 *
 * Responsibilities:
 *   1. Session gate: redirect to `/login` when no MFA-satisfied admin session
 *      exists. The server independently enforces MFA + RBAC on every request,
 *      so this gate is a UX convenience, not the security boundary.
 *   2. Role-scoped navigation: only sections the current role can use are shown
 *      (out-of-role sections are hidden to mirror the server guard — R21.2–R21.5).
 *   3. Standing privacy notice: a persistent banner states the inviolable
 *      guarantees — no black-box decrypt, no live GPS/audio, phone numbers
 *      masked, every action written to the append-only Admin_Audit_Ledger
 *      (R21.6, R21.7, R21.8, R21.9).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  clearSession,
  getSession,
  isAuthenticated,
  type AdminSession,
} from "../../lib/session";
import { visibleSections } from "../../lib/rbac";

/** Human-friendly label for the single admin role. */
const ROLE_LABEL: Record<AdminSession["role"], string> = {
  SUPER_ADMIN: "Super Admin",
  SUPPORT_AGENT: "Support Agent",
  BILLING_OPS: "Billing Ops",
};

export function ConsoleShell({ children }: { children: ReactNode }): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<AdminSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    setSession(getSession());
    setReady(true);
  }, [router]);

  if (!ready || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-typography/60">
        Opening the console…
      </div>
    );
  }

  const sections = visibleSections(session.role);

  return (
    <div className="min-h-screen">
      <header className="border-b border-typography/10 bg-canvas/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-4 py-3">
          <span className="mr-4 text-lg font-semibold">Kshema Ops</span>
          <nav className="flex flex-wrap items-center gap-1">
            {sections.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full px-3 py-1.5 text-sm ${
                    active
                      ? "bg-primary-action text-white"
                      : "text-typography/70 hover:bg-typography/5"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="rounded-full bg-typography/5 px-3 py-1 text-xs text-typography/70">
              {ROLE_LABEL[session.role]} · MFA verified
            </span>
            <button
              type="button"
              onClick={() => {
                clearSession();
                router.replace("/login");
              }}
              className="text-sm text-typography/60 hover:text-typography"
            >
              Sign out
            </button>
          </div>
        </div>
        <PrivacyBanner />
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

/**
 * The standing privacy notice. Kept visible on every console page so the
 * operator is always reminded of the inviolable guarantees (R21.6–R21.9).
 */
function PrivacyBanner(): JSX.Element {
  return (
    <div className="border-t border-typography/10 bg-healthy/10">
      <p className="mx-auto max-w-6xl px-4 py-2 text-xs text-typography/70">
        Phone numbers are shown masked to their last 4 digits. This console has
        no way to decrypt a Flight Recorder or to view live location or audio.
        Every view, query, and change you make is written to the append-only
        audit ledger with your identity, source IP, and justification.
      </p>
    </div>
  );
}
