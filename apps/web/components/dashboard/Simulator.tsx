"use client";
import { useEffect, useRef, useState } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

type Stage = 0 | 1 | 2 | 3 | 4;
const STAGES = [
  { n: 1, label: "Gentle WhatsApp check-in", detail: "“Good morning! All well today?” sent to Anchor." },
  { n: 2, label: "Soft device chime", detail: "A quiet chime plays on the Anchor’s phone." },
  { n: 3, label: "Observer silent alert", detail: "High-priority push to all Circle guardians." },
  { n: 4, label: "Hyperlocal dispatch", detail: "Neighbour + gate called; encrypted black box released." },
];

interface LogItem { t: string; msg: string; tone: "info" | "warn" | "good"; }

export function Simulator() {
  const [stage, setStage] = useState<Stage>(0);
  const [running, setRunning] = useState(false);
  const [compressed, setCompressed] = useState(true);
  const [log, setLog] = useState<LogItem[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const add = (msg: string, tone: LogItem["tone"] = "info") =>
    setLog((l) => [{ t: new Date().toLocaleTimeString(), msg, tone }, ...l].slice(0, 40));

  const stepMs = compressed ? 2500 : 20 * 60 * 1000;

  useEffect(() => () => clearTimeout(timer.current), []);

  function advance(to: Stage) {
    setStage(to);
    if (to >= 1 && to <= 4) {
      const s = STAGES[to - 1];
      add(`Stage ${to}: ${s.label} — ${s.detail}`, to >= 3 ? "warn" : "info");
    }
    if (to === 4) { add("Emergency access token minted · responder SMS sent", "warn"); setRunning(false); }
  }

  function start() {
    setLog([]); setRunning(true); setStage(0);
    add("Grace deadline passed without a confirmed routine", "warn");
    let cur: Stage = 0;
    const tick = () => {
      cur = (cur + 1) as Stage;
      advance(cur);
      if (cur < 4) timer.current = setTimeout(tick, stepMs);
    };
    timer.current = setTimeout(tick, 600);
  }

  function resolve(source: string) {
    clearTimeout(timer.current); setRunning(false); setStage(0);
    add(`Auto-resolved by ${source}. Escalation halted, Circle reassured.`, "good");
  }

  return (
    <div className="space-y-4">
      <Card><CardBody>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Escalation simulator</h3>
            <p className="text-sm text-typography/60">Exercise the four-stage state machine safely.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={compressed} onChange={(e) => setCompressed(e.target.checked)} />
            Time-warp (2.5s per stage)
          </label>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          {STAGES.map((s) => (
            <div key={s.n} className={cn("flex items-center gap-3 rounded-xl border p-3 transition-all",
              stage === s.n ? "border-escalating bg-escalating/10" : stage > s.n ? "border-black/5 bg-black/[0.02] opacity-60" : "border-black/5")}>
              <span className={cn("flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold",
                stage >= s.n ? "bg-escalating text-white" : "bg-black/10 text-typography/50")}>{s.n}</span>
              <div className="flex-1">
                <div className="text-sm font-medium">{s.label}</div>
                <div className="text-xs text-typography/55">{s.detail}</div>
              </div>
              {stage === s.n && running && <span className="h-2 w-2 animate-pulse rounded-full bg-escalating" />}
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button className="btn-primary" onClick={start} disabled={running}>Trigger missed routine</button>
          <button className="btn-outline" onClick={() => resolve("screen unlock")} disabled={!running && stage === 0}>Anchor unlocked phone</button>
          <button className="btn-outline" onClick={() => resolve("Ghost Signal (TV woke)")} disabled={!running && stage === 0}>Ghost Signal</button>
          <button className="btn-ghost text-escalating" onClick={() => resolve("Observer override")} disabled={!running && stage === 0}>Mark safe</button>
        </div>
      </CardBody></Card>

      <Card><CardBody>
        <div className="label mb-2">Event log</div>
        <div className="max-h-64 space-y-1.5 overflow-auto font-mono text-xs">
          {log.length === 0 && <div className="text-typography/40">No events yet. Trigger a scenario above.</div>}
          {log.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-typography/40">{l.t}</span>
              <span className={cn(l.tone === "warn" ? "text-escalating" : l.tone === "good" ? "text-healthy" : "text-typography/70")}>{l.msg}</span>
            </div>
          ))}
        </div>
      </CardBody></Card>
    </div>
  );
}
