import Link from "next/link";
import { notFound } from "next/navigation";
import { getAnchor, getVitality } from "@/lib/data";
import { Topbar } from "@/components/dashboard/Topbar";
import { Card, CardBody } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { Sparkline } from "@/components/ui/Sparkline";
import { wellbeingVisual, stageLabel, stageIndex, relativeTime } from "@/lib/wellbeing";
import { cn } from "@/lib/cn";
import { AnchorActions } from "@/components/dashboard/AnchorActions";

export default async function AnchorDetail({ params }: { params: { id: string } }) {
  const a = await getAnchor(params.id);
  if (!a) notFound();
  const days = await getVitality(a.id);
  const v = wellbeingVisual(a.wellbeing);
  const steps = days.map((d) => d.steps);
  const incident = a.activeIncident;

  return (
    <div>
      <Topbar title={a.preferredName} subtitle={a.timezone.replace("_", " ")} />
      <div className="mx-auto max-w-5xl px-5 py-6 sm:px-8">
        <Link href="/dashboard" className="text-sm text-typography/50 hover:text-typography">← Back to desk</Link>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardBody>
              <div className="flex items-center gap-4">
                <Avatar name={a.preferredName} hue={a.avatarHue} size={64} />
                <div>
                  <h2 className="text-2xl font-semibold">{a.preferredName}</h2>
                  <div className={cn("chip mt-1", v.bg, v.fg)}><span className={cn("h-1.5 w-1.5 rounded-full", v.dot)} />{v.label}</div>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Last seen well" value={relativeTime(a.lastConfirmationAt)} />
                <Stat label="Steps today" value={a.stepCount.toLocaleString()} />
                <Stat label="Battery" value={a.batteryPercent + "%"} />
                <Stat label="Streak" value={a.vitalityStreak + " days"} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="label">30-day step rhythm</div>
              <div className="mt-3"><Sparkline data={steps} width={240} height={60} /></div>
              <p className="mt-3 text-sm text-typography/60">Cooperative movement, never a competition.</p>
            </CardBody>
          </Card>
        </div>

        {incident && (
          <Card className="mt-4 ring-2 ring-escalating/30">
            <CardBody>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-escalating">Active safety check</h3>
                <span className="chip bg-escalating/15 text-escalating">Stage {stageIndex[incident.stage]}/4</span>
              </div>
              <ol className="mt-4 space-y-3">
                {incident.audit.map((e, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-escalating/15 text-xs font-semibold text-escalating">{i + 1}</span>
                    <div>
                      <div className="text-sm font-medium">{stageLabel[e.stage as keyof typeof stageLabel] ?? e.stage}</div>
                      <div className="text-xs text-typography/55">{e.cause} · {relativeTime(e.at)}</div>
                    </div>
                  </li>
                ))}
              </ol>
              <AnchorActions anchorName={a.preferredName} />
            </CardBody>
          </Card>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Card>
            <CardBody>
              <div className="label">Flight Recorder</div>
              <p className="mt-2 text-sm text-typography/65">
                Encrypted black box is {incident && stageIndex[incident.stage] >= 4 ? "released for emergency triage" : "sealed"}. Only you can decrypt it, and only during a real emergency — our servers never can.
              </p>
              <button className={cn("btn mt-3", incident && stageIndex[incident.stage] >= 4 ? "btn-primary" : "btn-outline opacity-60")} disabled={!(incident && stageIndex[incident.stage] >= 4)}>
                {incident && stageIndex[incident.stage] >= 4 ? "Decrypt in browser" : "Sealed 🔒"}
              </button>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="label">Persona modes</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {a.personaModes.map((p) => <span key={p} className="chip bg-black/5 text-typography/70">{p.replace(/_/g, " ").toLowerCase()}</span>)}
              </div>
              <Link href="/dashboard/config" className="mt-4 inline-block text-sm font-semibold text-primary-action">Adjust protection →</Link>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-sandalwood-cream p-3">
      <div className="label">{label}</div>
      <div className="mt-1 font-semibold">{value}</div>
    </div>
  );
}
