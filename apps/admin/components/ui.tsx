"use client";

/**
 * Small presentational primitives shared across console pages. All emphasis
 * uses the brand palette — Soft Amber for attention (`escalating`), Muted Sage
 * for healthy (`healthy`). No clinical red / hospital blue, no alarm styling
 * (R16.4, R22.20).
 */
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-typography/70">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }): JSX.Element {
  return (
    <p
      role="alert"
      className="rounded-lg border border-escalating/40 bg-escalating/10 px-4 py-3 text-sm text-typography"
    >
      {message}
    </p>
  );
}

export function SuccessNote({ message }: { message: string }): JSX.Element {
  return (
    <p
      role="status"
      className="rounded-lg border border-healthy/40 bg-healthy/10 px-4 py-3 text-sm text-typography"
    >
      {message}
    </p>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }): JSX.Element {
  return <p className="py-8 text-center text-typography/50">{label}</p>;
}

export function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  tone?: "neutral" | "healthy" | "attention";
}): JSX.Element {
  const toneClass =
    tone === "healthy"
      ? "border-healthy/40 bg-healthy/10"
      : tone === "attention"
        ? "border-escalating/40 bg-escalating/10"
        : "border-typography/10 bg-white/40";
  return (
    <div className={`rounded-xl border px-5 py-4 ${toneClass}`}>
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-sm text-typography/70">{label}</div>
    </div>
  );
}
