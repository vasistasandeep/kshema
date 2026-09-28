"use client";
import { useEffect, useState } from "react";

export function LiveClock({ tz, label }: { tz: string; label: string }) {
  const [time, setTime] = useState("");
  useEffect(() => {
    const tick = () => setTime(new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: tz }).format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [tz]);
  return (
    <div className="text-center">
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{time || "—"}</div>
      <div className="text-xs text-typography/50">{tz.replace("_", " ")}</div>
    </div>
  );
}
