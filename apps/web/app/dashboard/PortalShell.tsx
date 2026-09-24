"use client";

/**
 * Authenticated Observer portal shell. Guards the session (redirect to login
 * when signed out), enforces the 30-minute idle lock (R28.4), and renders the
 * portal navigation. All nav copy is Brand_Lexicon; no Banned_Term appears.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { clearSession, isAuthenticated } from "../../lib/session";
import { useIdleLock } from "../../lib/use-idle-lock";
import { LockScreen } from "./LockScreen";

const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/dashboard", label: "Ambient Desk" },
  { href: "/dashboard/vitality", label: "Connection Rhythm" },
  { href: "/dashboard/config", label: "Circle Settings" },
  { href: "/dashboard/billing", label: "Plan & Billing" },
];

export function PortalShell({ children }: { children: ReactNode }): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const { locked, unlock } = useIdleLock();
  const [ready, setReady] = useState(false);

  const isLoginRoute = pathname === "/dashboard/login";

  useEffect(() => {
    if (isLoginRoute) {
      setReady(true);
      return;
    }
    if (!isAuthenticated()) {
      router.replace("/dashboard/login");
      return;
    }
    setReady(true);
  }, [router, isLoginRoute]);

  // The login route renders bare (no nav / idle lock / session guard).
  if (isLoginRoute) {
    return <>{children}</>;
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-typography/60">
        Opening your portal…
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {locked ? <LockScreen onUnlock={unlock} /> : null}
      <header className="border-b border-typography/10 bg-canvas/80">
        <nav className="mx-auto flex max-w-5xl items-center gap-1 px-4 py-3">
          <span className="mr-4 text-lg font-semibold">Kshema</span>
          {NAV.map((item) => {
            const active =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href);
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
          <button
            type="button"
            onClick={() => {
              clearSession();
              router.replace("/dashboard/login");
            }}
            className="ml-auto text-sm text-typography/60 hover:text-typography"
          >
            Sign out
          </button>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
