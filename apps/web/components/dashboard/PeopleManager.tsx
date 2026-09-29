"use client";
import { useEffect, useState } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";

interface Member { id: string; name: string; role: string; canTriggerIVR: boolean; canAccessBlackBox: boolean; phoneLast4: string; }
type Role = "ANCHOR" | "OBSERVER" | "MUTUAL";

export function PeopleManager() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);

  // add-member form
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<Role>("ANCHOR");
  const [ivr, setIvr] = useState(false);
  const [bb, setBb] = useState(false);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500); };

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/circles/members");
      const j = await r.json();
      setMembers(j.members ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function addMember() {
    if (!name || !phone) { flash("Name and phone are required"); return; }
    const r = await fetch("/api/circles/add-member", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, phone, role, canTriggerIVR: ivr, canAccessBlackBox: bb }),
    });
    const j = await r.json();
    if (r.ok) { flash(`Added ${name} as ${role.toLowerCase()}`); setName(""); setPhone(""); void load(); }
    else flash(j.error || "Could not add member");
  }

  async function makeInvite(inviteRole: Role) {
    // Ensure a circle exists via members call; invite through the current circle.
    const mem = await fetch("/api/circles/members").then((x) => x.json());
    let circleId = mem.circleId;
    if (!circleId) {
      const c = await fetch("/api/circles/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "My Circle" }) }).then((x) => x.json());
      circleId = c.circleId ?? c.id;
    }
    const r = await fetch("/api/circles/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ circleId, role: inviteRole }) });
    const j = await r.json();
    const token = j.invitation?.inviteToken ?? j.inviteToken ?? j.token;
    if (token) {
      const url = `${window.location.origin}/onboarding?invite=${encodeURIComponent(token)}&role=${inviteRole}`;
      setInvite(url);
      await navigator.clipboard?.writeText(url).catch(() => {});
      flash("Invite link copied");
    } else flash(j.error || "Could not create invite");
  }

  return (
    <div className="space-y-4">
      {toast && <div className="fixed right-4 top-4 z-50 rounded-xl bg-healthy px-4 py-2 text-sm font-medium text-white shadow-lift">{toast}</div>}

      <Card><CardBody>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Circle members</h3>
          <button className="text-sm text-primary-action" onClick={() => void load()}>Refresh</button>
        </div>
        {loading ? <p className="mt-3 text-sm text-typography/50">Loading…</p> : (
          <div className="mt-3 divide-y divide-black/5">
            {members.length === 0 && <p className="py-3 text-sm text-typography/50">No members yet. Add someone below.</p>}
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <Avatar name={m.name} hue={(m.name.charCodeAt(0) * 37) % 360} size={36} />
                  <div>
                    <div className="text-sm font-medium">{m.name}</div>
                    <div className="text-xs text-typography/50">{m.role.toLowerCase()} · •••{m.phoneLast4}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  {m.canTriggerIVR && <span className="chip bg-primary-action/10 text-primary-action">dispatch</span>}
                  {m.canAccessBlackBox && <span className="chip bg-healthy/10 text-healthy">black box</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardBody></Card>

      <Card><CardBody>
        <h3 className="font-semibold">Add a member</h3>
        <p className="text-sm text-typography/60">Quickly add an Anchor or Observer to your Circle.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">Preferred name</span><input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amma" /></label>
          <label className="block"><span className="label">Phone</span><input className="input mt-1" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" /></label>
        </div>
        <div className="mt-3">
          <span className="label">Role</span>
          <div className="mt-1 flex gap-2">
            {(["ANCHOR","OBSERVER","MUTUAL"] as Role[]).map((r) => (
              <button key={r} onClick={() => setRole(r)} className={cn("chip border", role === r ? "border-primary-action bg-primary-action/10 text-primary-action" : "border-black/10 text-typography/60")}>{r.toLowerCase()}</button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={ivr} onChange={(e) => setIvr(e.target.checked)} />Can trigger dispatch</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={bb} onChange={(e) => setBb(e.target.checked)} />Can access black box</label>
        </div>
        <button className="btn-primary mt-4" onClick={() => void addMember()}>Add to Circle</button>
      </CardBody></Card>

      <Card><CardBody>
        <h3 className="font-semibold">Invite by link (self-service)</h3>
        <p className="text-sm text-typography/60">Generate a shareable link; the person joins and picks their role.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-outline" onClick={() => void makeInvite("ANCHOR")}>Invite an Anchor</button>
          <button className="btn-outline" onClick={() => void makeInvite("OBSERVER")}>Invite an Observer</button>
        </div>
        {invite && (
          <div className="mt-3 break-all rounded-xl bg-sandalwood-cream p-3 text-xs text-typography/70">{invite}</div>
        )}
      </CardBody></Card>
    </div>
  );
}
