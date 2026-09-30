"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Anchor, PanchangaCard } from "@/lib/types";
import { Logo } from "@/components/brand/Logo";
import { Card, CardBody } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

const SPARSH = [
  { key: "MORNING_CHAI", glyph: "☕", label: "Morning Chai" },
  { key: "PRANAM_BLESSING", glyph: "🙏", label: "Pranam" },
  { key: "MORNING_SUN", glyph: "☀️", label: "Morning Sun" },
  { key: "MARIGOLD_FLOWER", glyph: "🌼", label: "Marigold" },
  { key: "HEART_BLESSING", glyph: "💛", label: "Heart" },
];

export function AnchorHome({ anchor, panchanga }: { anchor: Anchor; panchanga: PanchangaCard }) {
  const router = useRouter();
  const [sent, setSent] = useState<string | null>(null);
  const [sparshBusy, setSparshBusy] = useState(false);
  const [wellBusy, setWellBusy] = useState(false);
  const [wellMsg, setWellMsg] = useState<string | null>(null);

  const escalating = anchor.wellbeing === "ESCALATING";

  async function sendSparsh(key: string, label: string) {
    setSparshBusy(true);
    try {
      const res = await fetch("/api/anchor/sparsh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchorId: anchor.id, type: key }),
      });
      if (res.ok) setSent(label);
      else setSent(null);
    } catch { setSent(null); }
    finally { setSparshBusy(false); }
  }

  async function imWell() {
    setWellBusy(true); setWellMsg(null);
    try {
      const res = await fetch("/api/anchor/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchorId: anchor.id }),
      });
      const j = await res.json();
      if (res.ok) {
        setWellMsg("Sent — your Circle knows you’re well.");
        // Reflect the resolved state from the server.
        router.refresh();
      } else {
        setWellMsg("Could not reach your Circle: " + (j.error ?? res.status));
      }
    } catch (e) {
      setWellMsg("Could not reach your Circle: " + String(e));
    } finally {
      setWellBusy(false);
    }
  }

  return (
    <main className="min-h-screen">
      <header className="mx-auto flex max-w-lg items-center justify-between px-5 py-4">
        <Logo />
        <Link href="/dashboard" className="btn-ghost text-sm">Observer view</Link>
      </header>
      <div className="mx-auto max-w-lg space-y-4 px-5 py-2 pb-24">
        {escalating ? (
          <Card className="bg-escalating/[0.08]"><CardBody>
            <div className="chip bg-escalating/15 text-escalating"><span className="h-1.5 w-1.5 rounded-full bg-escalating" />Checking in</div>
            <h1 className="mt-3 text-2xl font-semibold">Hello, {anchor.preferredName.split(" ")[0]}</h1>
            <p className="mt-1 text-typography/65">Your Circle just wants to make sure you’re alright. One tap lets them know.</p>
          </CardBody></Card>
        ) : (
          <Card className="bg-healthy/[0.08]"><CardBody>
            <div className="chip bg-healthy/15 text-healthy"><span className="h-1.5 w-1.5 rounded-full bg-healthy" />All Well</div>
            <h1 className="mt-3 text-2xl font-semibold">Good morning, {anchor.preferredName.split(" ")[0]}</h1>
            <p className="mt-1 text-typography/65">Your morning routine is confirmed. Your Circle knows you’re well — no need to do a thing.</p>
            <div className="mt-4 flex items-center gap-4 text-sm">
              <span className="text-celebration font-medium">{anchor.vitalityStreak} day streak 🔥</span>
              {anchor.weather && <span className="text-typography/60">{anchor.weather.tempC}°C · {anchor.weather.summary}</span>}
            </div>
          </CardBody></Card>
        )}

        <Card><CardBody>
          <div className="label">Let your Circle know you’re well</div>
          <button onClick={imWell} disabled={wellBusy}
            className={cn("btn-primary mt-3 w-full", wellBusy && "opacity-60")}>
            {wellBusy ? "Sending…" : "I’m well"}
          </button>
          {wellMsg && <p className="mt-3 text-sm font-medium text-healthy">{wellMsg}</p>}
        </CardBody></Card>

        <Card><CardBody>
          <div className="label">Send a warm hello to your Circle</div>
          <div className="mt-3 grid grid-cols-5 gap-2">
            {SPARSH.map((s) => (
              <button key={s.key} onClick={() => sendSparsh(s.key, s.label)} disabled={sparshBusy}
                className={cn("flex flex-col items-center gap-1 rounded-2xl border p-3 transition-all",
                  sent === s.label ? "border-celebration bg-celebration/10" : "border-black/10 hover:bg-black/[0.03]",
                  sparshBusy && "opacity-60")}>
                <span className="text-2xl">{s.glyph}</span>
                <span className="text-[10px] text-typography/60">{s.label}</span>
              </button>
            ))}
          </div>
          {sent && <p className="mt-3 text-sm font-medium text-celebration">Sent {sent} to your Circle 💕</p>}
        </CardBody></Card>

        <Card className="bg-gradient-to-br from-celebration/10 to-primary-action/5"><CardBody>
          <div className="flex items-center justify-between">
            <div className="label">Daily Panchanga</div>
            <span className="text-xs text-typography/50">{new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" })}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <Info k="Sunrise" v={panchanga.sunrise} />
            <Info k="Sunset" v={panchanga.sunset} />
            <Info k="Tithi" v={panchanga.tithi} />
            <Info k="Nakshatra" v={panchanga.nakshatra} />
          </div>
          {panchanga.festival && <div className="mt-3 chip bg-celebration/15 text-celebration">{panchanga.festival}</div>}
          <p className="mt-3 border-t border-black/5 pt-3 text-sm italic text-typography/70">“{panchanga.proverb}”</p>
        </CardBody></Card>

        <Card><CardBody>
          <div className="label">Family movement journey</div>
          <p className="mt-1 text-sm text-typography/65">Together your Circle walked <b>18.4 km</b> this week — like a stroll along the Kaveri. 🚶‍♀️🚶</p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/10"><div className="h-full rounded-full bg-celebration" style={{ width: "72%" }} /></div>
        </CardBody></Card>
      </div>
    </main>
  );
}
function Info({ k, v }: { k: string; v: string }) {
  return <div><div className="text-xs text-typography/50">{k}</div><div className="font-medium">{v}</div></div>;
}
