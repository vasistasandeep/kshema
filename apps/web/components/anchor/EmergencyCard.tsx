"use client";
import { useState } from "react";
import type { HyperlocalProfile } from "@/lib/types";

export function EmergencyCard({ anchorName, profile }: { anchorName: string; profile: HyperlocalProfile }) {
  const [done, setDone] = useState(false);
  const [responder, setResponder] = useState("");
  if (done) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-healthy px-6 text-center text-white">
        <div>
          <div className="text-5xl">✓</div>
          <h1 className="mt-4 text-2xl font-semibold">Thank you, {responder || "friend"}</h1>
          <p className="mt-2 text-white/80">The Circle has been notified that {anchorName} is safe.</p>
        </div>
      </main>
    );
  }
  return (
    <main className="min-h-screen bg-deep-charcoal px-5 py-6 text-white">
      <div className="mx-auto max-w-md">
        <div className="rounded-2xl bg-escalating p-4 text-center font-semibold">Someone near you may need help</div>
        <div className="mt-4 rounded-2xl bg-white p-5 text-deep-charcoal">
          <div className="text-xs font-medium uppercase tracking-wide text-deep-charcoal/50">Please check on</div>
          <h1 className="mt-1 text-3xl font-semibold">{anchorName}</h1>
          <dl className="mt-4 space-y-2 text-sm">
            <Row k="Society" v={profile.society} />
            <Row k="Block / Flat" v={profile.block + " · " + profile.flat} />
            <Row k="Door access" v={profile.doorAccessNotes} />
            <Row k="Smart-lock backup" v={profile.smartLockCode} />
          </dl>
          <a href="tel:+910000000000" className="btn-primary mt-5 w-full">📞 Call primary guardian</a>
        </div>
        <div className="mt-4 rounded-2xl bg-white/10 p-5">
          <label className="text-sm text-white/80">Your name (for the family)</label>
          <input className="input mt-2 text-deep-charcoal" value={responder} onChange={(e) => setResponder(e.target.value)} placeholder="e.g. Security – Gate B" />
          <button className="btn mt-3 w-full bg-healthy text-white" onClick={() => setDone(true)}>I’ve reached them — confirm safe</button>
        </div>
        <p className="mt-4 text-center text-xs text-white/40">Kshema · read-only emergency triage · no login required</p>
      </div>
    </main>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-4 border-b border-black/5 pb-2"><dt className="text-deep-charcoal/50">{k}</dt><dd className="text-right font-medium">{v}</dd></div>;
}
