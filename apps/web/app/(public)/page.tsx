import Link from "next/link";
import { Logo } from "@/components/brand/Logo";

const stages = [
  { n: 1, title: "Gentle check-in", body: "A warm WhatsApp note asks if all is well." },
  { n: 2, title: "Soft device chime", body: "A quiet chime on the phone, nothing alarming." },
  { n: 3, title: "Observer alert", body: "Circle guardians get a high-priority nudge." },
  { n: 4, title: "Nearby help", body: "Only if needed — neighbours & gate are called." },
];

const features = [
  { icon: "🕊️", title: "Ambient, not intrusive", body: "Well-being is inferred from signals your phone already produces. No cameras, no tracking, no ‘I am alive’ buttons." },
  { icon: "🔐", title: "Zero-knowledge", body: "The Flight Recorder is encrypted so even our servers can’t read it. Only an authorised guardian can, and only in a real emergency." },
  { icon: "🌸", title: "Warm by design", body: "Streaks, Sparsh greetings and a daily Panchanga card make opening Kshema a heartwarming habit." },
  { icon: "🌏", title: "Five languages", body: "English, Hindi, Kannada, Tamil and Telugu — safety in the language you think in." },
];

export default function Landing() {
  return (
    <main className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/pricing" className="btn-ghost">Pricing</Link>
          <Link href="/privacy" className="btn-ghost">Privacy</Link>
          <Link href="/dashboard" className="btn-primary">Open dashboard</Link>
        </nav>
      </header>

      <section className="mx-auto max-w-6xl px-6 pt-10 pb-16 text-center">
        <span className="chip bg-healthy/10 text-healthy mb-6">Dignity over surveillance</span>
        <h1 className="mx-auto max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">
          Peace of mind for the people you hold close.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-typography/70">
          Kshema quietly notices that your loved ones are up and about — from the gentle rhythms of everyday life — and reassures you, without ever watching over them.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link href="/onboarding" className="btn-primary px-7 py-3 text-base">Get started free</Link>
          <Link href="/dashboard" className="btn-outline px-7 py-3 text-base">See the dashboard</Link>
        </div>
        <p className="mt-4 text-sm text-typography/50">14-day full-access trial · no card required</p>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <div key={f.title} className="card card-pad animate-fade-in">
              <div className="text-3xl">{f.icon}</div>
              <h3 className="mt-3 font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm text-typography/65">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="card card-pad">
          <div className="mb-6 text-center">
            <h2 className="text-2xl font-semibold">A graduated, gentle escalation</h2>
            <p className="mt-2 text-typography/65">Help only intensifies if signals keep suggesting something is wrong.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {stages.map((s) => (
              <div key={s.n} className="relative rounded-2xl border border-black/5 bg-sandalwood-cream p-5">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-terracotta font-semibold text-white">{s.n}</div>
                <h4 className="mt-3 font-semibold">{s.title}</h4>
                <p className="mt-1 text-sm text-typography/65">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="card card-pad">
          <div className="mb-6 text-center">
            <h2 className="text-2xl font-semibold">Explore the live demo</h2>
            <p className="mt-2 text-typography/65">Every surface, wired to the live backend. Amma is the seeded Anchor.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <DemoLink href="/dashboard" title="Observer dashboard" body="Live well-being of every Anchor in the Circle." />
            <DemoLink href="/anchor/cmud5ygks0000pvev3t22w2bc" title="Anchor home (Amma)" body="Sanctuary view with the ‘I’m well’ heartbeat and Sparsh." />
            <DemoLink href="/dashboard/anchors/cmud5ygks0000pvev3t22w2bc" title="Anchor detail + Flight Recorder" body="Incident timeline and the gated Encrypted Black Box." />
            <DemoLink href="/dashboard/people" title="Members & permissions" body="Add Anchors/Observers, set black-box access." />
            <DemoLink href="/dashboard/simulate" title="Escalation simulator" body="Drive the four-stage safety pipeline safely." />
            <DemoLink href="/dashboard/vitality" title="Vitality rhythm" body="30-day routine-confirmation history." />
            <DemoLink href="/dashboard/config" title="Sentinel policy" body="Tune protection windows and persona modes." />
            <DemoLink href="/dashboard/billing" title="Billing & plan" body="Subscription tier and invoices." />
            <DemoLink href="/onboarding" title="Onboarding" body="Create an identity and join a Circle." />
          </div>
        </div>
      </section>

      <footer className="border-t border-black/5">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-sm text-typography/50 sm:flex-row">
          <Logo mark={false} />
          <p>Kshema is an ambient routine-assurance utility — not a medical device or emergency service.</p>
        </div>
      </footer>
    </main>
  );
}

function DemoLink({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Link href={href} className="group rounded-2xl border border-black/5 bg-sandalwood-cream p-5 transition-all hover:border-primary-action/40 hover:shadow-sm">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{title}</h4>
        <span className="text-primary-action opacity-0 transition-opacity group-hover:opacity-100">→</span>
      </div>
      <p className="mt-1 text-sm text-typography/65">{body}</p>
    </Link>
  );
}
