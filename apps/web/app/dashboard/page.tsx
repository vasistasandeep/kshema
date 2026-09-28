import { getDashboard } from "@/lib/data";
import { Topbar } from "@/components/dashboard/Topbar";
import { LiveClock } from "@/components/dashboard/LiveClock";
import { AnchorCard } from "@/components/dashboard/AnchorCard";
import { Card, CardBody } from "@/components/ui/Card";

export default async function AmbientDesk() {
  const d = await getDashboard();
  const wellCount = d.anchors.filter((a) => a.wellbeing === "ALL_WELL").length;
  const escalating = d.anchors.filter((a) => a.wellbeing === "ESCALATING");
  const anchorTz = d.anchors[0]?.timezone ?? "Asia/Kolkata";

  return (
    <div>
      <Topbar title="Ambient Desk" subtitle={d.circle.name} />
      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8">

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className={escalating.length ? "lg:col-span-2 ring-2 ring-escalating/30" : "lg:col-span-2 bg-healthy/[0.06]"}>
            <CardBody>
              {escalating.length ? (
                <div>
                  <div className="chip bg-escalating/15 text-escalating">Needs attention</div>
                  <h2 className="mt-3 text-2xl font-semibold">{escalating.length} anchor{escalating.length > 1 ? "s" : ""} may need a check</h2>
                  <p className="mt-1 text-typography/65">Gentle escalation is underway. You can reach out directly or mark them safe.</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {escalating.map((a) => (
                      <span key={a.id} className="chip bg-white text-escalating shadow-sm">{a.preferredName}</span>
                    ))}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="chip bg-healthy/15 text-healthy"><span className="h-1.5 w-1.5 rounded-full bg-healthy" />All Well</div>
                  <h2 className="mt-3 text-2xl font-semibold">Everyone is well this morning</h2>
                  <p className="mt-1 text-typography/65">{wellCount} of {d.anchors.length} anchors confirmed their routine. Nothing needs your attention.</p>
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody className="flex items-center justify-around">
              <LiveClock tz={d.observerTimezone} label="Your time" />
              <div className="h-10 w-px bg-black/10" />
              <LiveClock tz={anchorTz} label="Anchor time" />
            </CardBody>
          </Card>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <h3 className="font-semibold">Your anchors</h3>
          <span className="text-sm text-typography/50">{d.anchors.length} people</span>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {d.anchors.map((a) => <AnchorCard key={a.id} a={a} />)}
        </div>
      </div>
    </div>
  );
}
