"use client";
import { useState } from "react";
export function BillingActions({ interval }: { interval: "MONTHLY" | "ANNUAL" }) {
  const [iv, setIv] = useState(interval);
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button className="btn-primary">Upgrade to Pro</button>
      <div className="inline-flex rounded-full border border-black/10 bg-white p-1 text-sm">
        {(["MONTHLY","ANNUAL"] as const).map((o) => (
          <button key={o} onClick={() => setIv(o)}
            className={"rounded-full px-4 py-1.5 font-medium " + (iv === o ? "bg-primary-action text-white" : "text-typography/60")}>
            {o === "MONTHLY" ? "Monthly" : "Annual · save 20%"}
          </button>
        ))}
      </div>
    </div>
  );
}
