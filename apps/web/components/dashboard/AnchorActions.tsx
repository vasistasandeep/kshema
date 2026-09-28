"use client";
import { useState } from "react";

export function AnchorActions({ anchorName }: { anchorName: string }) {
  const [resolved, setResolved] = useState(false);
  if (resolved) {
    return <div className="mt-4 rounded-xl bg-healthy/10 p-3 text-sm font-medium text-healthy">✓ Marked {anchorName} safe. The Circle has been notified.</div>;
  }
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      <button className="btn-primary" onClick={() => setResolved(true)}>Mark safe</button>
      <a href="tel:+910000000000" className="btn-outline">Call {anchorName}</a>
      <button className="btn-ghost text-escalating">Escalate to nearby help</button>
    </div>
  );
}
