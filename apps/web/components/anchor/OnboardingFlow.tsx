"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { cn } from "@/lib/cn";

const steps = ["Welcome","Verify","Disclaimer","Your name","Finish"] as const;

export function OnboardingFlow() {
  const router = useRouter();
  const search = useSearchParams();
  const inviteToken = search.get("invite");
  const inviteRole = search.get("role") || "OBSERVER";

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const next = () => setStep((s) => Math.min(steps.length - 1, s + 1));

  async function finish() {
    setBusy(true); setErr(null);
    try {
      if (inviteToken) {
        // Joiner path: create session + join the circle with the chosen role.
        const r = await fetch("/api/circles/join", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ inviteToken, role: inviteRole, phone, preferredName: name }),
        });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "Could not join circle"); }
      } else {
        // Founder path: create session, then create a circle.
        const s = await fetch("/api/session/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, preferredName: name }) });
        if (!s.ok) throw new Error("Login failed");
        const c = await fetch("/api/circles/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: (name ? name.split(" ")[0] + "’s" : "My") + " Circle" }) });
        if (!c.ok) throw new Error("Could not create circle");
      }
      router.push("/dashboard");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col px-6 py-8">
      <Logo />
      {inviteToken && <div className="mt-4 chip bg-healthy/10 text-healthy">You’ve been invited to join a Circle as {inviteRole.toLowerCase()}</div>}
      <div className="mt-4 flex gap-1.5">
        {steps.map((_, i) => <span key={i} className={cn("h-1.5 flex-1 rounded-full", i <= step ? "bg-primary-action" : "bg-black/10")} />)}
      </div>

      <div className="mt-10 flex-1 animate-fade-in">
        {step === 0 && (
          <div>
            <h1 className="text-3xl font-semibold">Welcome to Kshema</h1>
            <p className="mt-3 text-typography/70">We’ll create a private security key that stays on your device, then connect you to your Circle.</p>
            <button className="btn-primary mt-8 w-full" onClick={next}>Create my secure identity</button>
          </div>
        )}
        {step === 1 && (
          <div>
            <h1 className="text-3xl font-semibold">Verify your number</h1>
            <p className="mt-3 text-typography/70">Your private key never leaves this device.</p>
            <input className="input mt-6" placeholder="+91 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button className="btn-primary mt-4 w-full" onClick={next} disabled={phone.trim().length < 6}>Continue</button>
          </div>
        )}
        {step === 2 && (
          <div>
            <h1 className="text-3xl font-semibold">A quick, honest note</h1>
            <div className="mt-4 rounded-2xl bg-sandalwood-cream p-4 text-sm text-typography/70">
              Kshema is an ambient routine-assurance and notification utility. It is <b>not</b> a licensed medical device, a security company, or an official emergency service, and it depends on cellular networks and third-party gateways.
            </div>
            <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1" />I understand and accept the terms and safety disclaimer.</label>
            <button className="btn-primary mt-6 w-full" onClick={next} disabled={!accepted}>Continue</button>
          </div>
        )}
        {step === 3 && (
          <div>
            <h1 className="text-3xl font-semibold">What should we call you?</h1>
            <input className="input mt-6" placeholder="e.g. Lakshmi Amma" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn-primary mt-4 w-full" onClick={next} disabled={name.trim().length < 2}>Continue</button>
          </div>
        )}
        {step === 4 && (
          <div>
            <h1 className="text-3xl font-semibold">You’re all set{name ? ", " + name.split(" ")[0] : ""} 🌸</h1>
            <p className="mt-3 text-typography/70">{inviteToken ? "Join your Circle to start sharing peace of mind." : "We’ll create your Circle and open your dashboard."}</p>
            {err && <p className="mt-3 text-sm text-escalating">{err}</p>}
            <button className="btn-primary mt-8 w-full" onClick={() => void finish()} disabled={busy}>{busy ? "Setting up…" : inviteToken ? "Join Circle" : "Create Circle & open dashboard"}</button>
          </div>
        )}
      </div>
    </div>
  );
}
