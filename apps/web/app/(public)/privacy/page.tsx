import Link from "next/link";
import { Logo } from "@/components/brand/Logo";

const points = [
  { t: "No continuous location tracking", b: "We never store a continuous GPS trace during normal operation. Location is disclosed to guardians only during a real Stage-4 emergency or a silent SOS." },
  { t: "Zero-knowledge Flight Recorder", b: "Recent context is encrypted on-device so our servers cannot read it. Only an authorised guardian can decrypt it, in the browser, during an emergency." },
  { t: "No cameras, no always-on mic upload", b: "Distress sounds are classified on-device, in memory. Raw audio never leaves the phone and is never stored." },
  { t: "No data sale, no cross-app tracking", b: "We do not sell your data or track you across other apps. Data-safety labels match our real runtime behaviour." },
];

export default function Privacy() {
  return (
    <main className="min-h-screen">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link href="/"><Logo /></Link>
        <Link href="/dashboard" className="btn-ghost">Dashboard</Link>
      </header>
      <section className="mx-auto max-w-3xl px-6 py-10">
        <span className="chip bg-healthy/10 text-healthy">Dignity over surveillance</span>
        <h1 className="mt-4 text-4xl font-semibold">Privacy is the product</h1>
        <p className="mt-3 text-typography/65">Kshema is built so that everyday life stays private and safety is inferred ambiently — never through watching.</p>
        <div className="mt-8 space-y-4">
          {points.map((p) => (
            <div key={p.t} className="card card-pad">
              <h3 className="font-semibold">{p.t}</h3>
              <p className="mt-1.5 text-sm text-typography/65">{p.b}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
