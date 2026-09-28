"use client";
import { useState } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import type { SentinelPolicy, HyperlocalProfile, CircleMember } from "@/lib/types";
import { cn } from "@/lib/cn";

const PERSONAS = ["ELDERLY_CARE","SOLO_LIVING","ACTIVE_SESSION","JOURNEY_WATCH","POST_OP_RECOVERY"] as const;

export function ConfigForms({ policy, hyperlocal, members }: { policy: SentinelPolicy; hyperlocal: HyperlocalProfile; members: CircleMember[] }) {
  const [modes, setModes] = useState<string[]>(policy.personaModes);
  const [saved, setSaved] = useState<string | null>(null);
  const toggle = (m: string) => setModes((s) => s.includes(m) ? s.filter((x) => x !== m) : [...s, m]);
  const flash = (s: string) => { setSaved(s); setTimeout(() => setSaved(null), 2000); };

  return (
    <div className="space-y-4">
      {saved && <div className="fixed right-4 top-4 z-50 rounded-xl bg-healthy px-4 py-2 text-sm font-medium text-white shadow-lift">✓ {saved}</div>}

      <Card><CardBody>
        <h3 className="font-semibold">Sentinel policy</h3>
        <p className="text-sm text-typography/60">How Kshema watches for well-being.</p>
        <div className="mt-4">
          <div className="label mb-2">Persona modes</div>
          <div className="flex flex-wrap gap-2">
            {PERSONAS.map((p) => (
              <button key={p} onClick={() => toggle(p)}
                className={cn("chip border transition-colors", modes.includes(p) ? "border-primary-action bg-primary-action/10 text-primary-action" : "border-black/10 text-typography/60")}>
                {p.replace(/_/g, " ").toLowerCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Expected wake"><input type="time" defaultValue={policy.expectedWake} className="input" /></Field>
          <Field label="Expected bed"><input type="time" defaultValue={policy.expectedBed} className="input" /></Field>
          <Field label="Grace window (minutes)"><input type="number" defaultValue={policy.graceMinutes} className="input" /></Field>
          <Field label="Language"><select defaultValue={policy.language} className="input"><option value="en">English</option><option value="hi">Hindi</option><option value="kn">Kannada</option><option value="ta">Tamil</option><option value="te">Telugu</option></select></Field>
        </div>
        <button className="btn-primary mt-4" onClick={() => flash("Sentinel policy saved")}>Save policy</button>
      </CardBody></Card>

      <Card><CardBody>
        <h3 className="font-semibold">Hyperlocal contacts</h3>
        <p className="text-sm text-typography/60">Used only during a Stage-4 emergency dispatch.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Society"><input defaultValue={hyperlocal.society} className="input" /></Field>
          <Field label="Block"><input defaultValue={hyperlocal.block} className="input" /></Field>
          <Field label="Flat"><input defaultValue={hyperlocal.flat} className="input" /></Field>
          <Field label="Gate contact"><input defaultValue={hyperlocal.gateContact} className="input" /></Field>
          <Field label="Neighbour contact"><input defaultValue={hyperlocal.neighborContact} className="input" /></Field>
          <Field label="Smart-lock backup code"><input defaultValue={hyperlocal.smartLockCode} className="input" /></Field>
        </div>
        <Field label="Door-access notes" className="mt-4"><textarea defaultValue={hyperlocal.doorAccessNotes} rows={2} className="input" /></Field>
        <button className="btn-primary mt-4" onClick={() => flash("Hyperlocal profile saved")}>Save contacts</button>
      </CardBody></Card>

      <Card><CardBody>
        <h3 className="font-semibold">Circle members</h3>
        <div className="mt-4 divide-y divide-black/5">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between py-3">
              <div>
                <div className="text-sm font-medium">{m.name}</div>
                <div className="text-xs text-typography/50">{m.role.toLowerCase()}</div>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {m.canTriggerIVR && <span className="chip bg-primary-action/10 text-primary-action">can dispatch</span>}
                {m.canAccessBlackBox && <span className="chip bg-healthy/10 text-healthy">black box</span>}
                <span className={cn("h-2 w-2 rounded-full", m.online ? "bg-healthy" : "bg-black/20")} />
              </div>
            </div>
          ))}
        </div>
        <button className="btn-outline mt-4" onClick={() => flash("Invitation link copied")}>Invite a member</button>
      </CardBody></Card>
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={cn("block", className)}><span className="label">{label}</span><div className="mt-1.5">{children}</div></label>;
}
