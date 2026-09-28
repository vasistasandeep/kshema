import { getDashboard, getVitality } from "@/lib/data";
import { Topbar } from "@/components/dashboard/Topbar";
import { Card, CardBody } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

export default async function VitalityPage() {
  const d = await getDashboard();
  const anchor = d.anchors[0];
  const days = await getVitality(anchor.id);
  const confirmedCount = days.filter((x) => x.confirmed).length;
  const sparshCount = days.reduce((n, x) => n + x.sparsh.length, 0);

  return (
    <div>
      <Topbar title="Vitality" subtitle={`30-day connection rhythm · ${anchor.preferredName}`} />
      <div className="mx-auto max-w-5xl px-5 py-6 sm:px-8">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Mornings confirmed" value={`${confirmedCount}/30`} tone="healthy" />
          <Stat label="Current streak" value={`${anchor.vitalityStreak} days`} tone="celebration" />
          <Stat label="Sparsh shared" value={String(sparshCount)} tone="primary" />
        </div>

        <Card className="mt-6">
          <CardBody>
            <div className="label mb-3">Morning confirmations</div>
            <div className="grid grid-cols-10 gap-2">
              {days.map((x) => (
                <div key={x.date} title={`${x.date}${x.confirmationTime ? " · " + x.confirmationTime : " · missed"}`}
                  className={cn("aspect-square rounded-md", x.confirmed ? "bg-healthy" : "bg-black/10")}
                  style={{ opacity: x.confirmed ? 0.45 + (x.steps / 8000) * 0.55 : 1 }} />
              ))}
            </div>
            <div className="mt-3 flex items-center gap-4 text-xs text-typography/50">
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-healthy" />Confirmed (darker = more active)</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-black/10" />Missed</span>
            </div>
          </CardBody>
        </Card>

        <Card className="mt-4">
          <CardBody>
            <div className="label mb-3">Recent mornings</div>
            <div className="divide-y divide-black/5">
              {days.slice(-8).reverse().map((x) => (
                <div key={x.date} className="flex items-center justify-between py-2.5 text-sm">
                  <span className="text-typography/70">{new Date(x.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
                  <span className={cn("font-medium", x.confirmed ? "text-healthy" : "text-typography/40")}>
                    {x.confirmed ? `Confirmed ${x.confirmationTime}` : "No confirmation"}
                  </span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "healthy" | "celebration" | "primary" }) {
  const bg = tone === "healthy" ? "bg-healthy/10" : tone === "celebration" ? "bg-celebration/10" : "bg-primary-action/10";
  const fg = tone === "healthy" ? "text-healthy" : tone === "celebration" ? "text-celebration" : "text-primary-action";
  return (
    <div className={cn("card card-pad", bg)}>
      <div className="label">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold", fg)}>{value}</div>
    </div>
  );
}
