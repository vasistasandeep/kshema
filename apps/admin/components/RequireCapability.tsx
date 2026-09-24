"use client";

/**
 * Client-side capability gate for a whole page (R21.2–R21.5).
 *
 * If the current role cannot use `capability`, the page renders a calm
 * "not available for your role" notice instead of the feature. This mirrors the
 * server guard so an operator who deep-links to an out-of-role page sees a clear
 * message rather than a raw 403 — but the server still independently rejects any
 * request and records a SECURITY_VIOLATION, so this is UX, not enforcement.
 */
import { useEffect, useState, type ReactNode } from "react";
import { getSession, type AdminSession } from "../lib/session";
import { isPermitted, type AdminCapability } from "../lib/rbac";
import { ErrorNote } from "./ui";

export function RequireCapability({
  capability,
  children,
}: {
  capability: AdminCapability;
  children: ReactNode;
}): JSX.Element {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSession(getSession());
    setReady(true);
  }, []);

  if (!ready) return <></>;
  if (!session || !isPermitted(session.role, capability)) {
    return (
      <ErrorNote message="This section is not available for your admin role." />
    );
  }
  return <>{children}</>;
}
