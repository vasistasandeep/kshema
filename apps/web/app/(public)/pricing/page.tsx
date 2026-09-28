import Link from "next/link";
import { Logo } from "@/components/brand/Logo";

const plans = [
  { name: "Trial", price: "Free", period: "14 days", features: ["Full protection","All persona modes","Emergency dispatch","No card required"], cta: "Start free", highlight: false },
  { name: "Pro Monthly", price: "₹499", period: "per month", features: ["Everything in Trial","WhatsApp + IVR dispatch","Zero-knowledge Flight Recorder","Priority carrier fallback"], cta: "Go Pro", highlight: true },
  { name: "Pro Annual", price: "₹4,790", period: "per year · save 20%", features: ["Everything in Pro","2 months free","Tax invoices","Multi-Anchor Circles"], cta: "Go Annual", highlight: false },
];

export default function Pricing() {
  return (
    <main className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/"><Logo /></Link>
        <Link href="/dashboard" className="btn-primary">Open dashboard</Link>
      </header>
      <section className="mx-auto max-w-6xl px-6 py-12 text-center">
        <h1 className="text-4xl font-semibold">Simple, honest pricing</h1>
        <p className="mt-3 text-typography/65">One plan protects your whole Circle. Cancel anytime.</p>
        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {plans.map((p) => (
            <div key={p.name} className={"card card-pad text-left " + (p.highlight ? "ring-2 ring-primary-action" : "")}>
              {p.highlight && <span className="chip bg-primary-action/10 text-primary-action">Most popular</span>}
              <h3 className="mt-2 text-lg font-semibold">{p.name}</h3>
              <div className="mt-2 flex items-baseline gap-1"><span className="text-3xl font-semibold">{p.price}</span><span className="text-sm text-typography/50">{p.period}</span></div>
              <ul className="mt-4 space-y-2 text-sm text-typography/70">
                {p.features.map((f) => <li key={f} className="flex gap-2"><span className="text-healthy">✓</span>{f}</li>)}
              </ul>
              <Link href="/onboarding" className={(p.highlight ? "btn-primary" : "btn-outline") + " mt-5 w-full"}>{p.cta}</Link>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
