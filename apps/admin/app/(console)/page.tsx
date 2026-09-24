"use client";

/**
 * Console home. A calm landing that routes the operator to the sections their
 * single role can use (mirroring the server RBAC — R21.2–R21.5).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSession, type AdminSession } from "../../lib/session";
import { visibleSections } from "../../lib/rbac";
import { PageHeader } from "../../components/ui";

export default function ConsoleHome(): JSX.Element {
  const [session, setSession] = useState<AdminSession | null>(null);

  useEffect(() => {
    setSession(getSession());
  }, []);

  const sections = session ? visibleSections(session.role) : [];

  return (
    <div>
      <PageHeader
        title="Operations Console"
        description="Monitor fleet reliability, carrier gateway health, and live incidents, and support families through subscription exceptions — all within the same zero-knowledge privacy guarantees the platform gives every Circle."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-xl border border-typography/10 bg-white/40 px-5 py-6 transition hover:border-primary-action/40"
          >
            <div className="text-lg font-medium">{s.label}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
