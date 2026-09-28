import Link from "next/link";
import type { Anchor } from "@/lib/types";
import { Avatar } from "@/components/ui/Avatar";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { wellbeingVisual, stageLabel, stageIndex, relativeTime } from "@/lib/wellbeing";
import { cn } from "@/lib/cn";

export function AnchorCard({ a }: { a: Anchor }) {
  const v = wellbeingVisual(a.wellbeing);
  const escalating = a.wellbeing === "ESCALATING" && a.activeIncident;
  return (
    <Link href={`/dashboard/anchors/${a.id}`}
      className={cn("card card-pad block transition-all hover:shadow-lift",
        escalating && "ring-2 ring-escalating/40")}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Avatar name={a.preferredName} hue={a.avatarHue} />
          <div>
            <div className="font-semibold">{a.preferredName}</div>
            <div className={cn("chip mt-1", v.bg, v.fg)}>
              <span className={cn("h-1.5 w-1.5 rounded-full", v.dot)} />{v.label}
            </div>
          </div>
        </div>
        <ProgressRing value={a.batteryPercent} label={a.batteryPercent + "%"}
          color={a.batteryPercent < 20 ? "#D9822B" : "#3D6B52"} />
      </div>

      {escalating ? (
        <div className="mt-4 rounded-xl bg-escalating/10 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-escalating">{stageLabel[a.activeIncident!.stage]}</span>
            <span className="text-escalating/80">Stage {stageIndex[a.activeIncident!.stage]}/4</span>
          </div>
          <div className="mt-2 flex gap-1">
            {[1,2,3,4].map((n) => (
              <span key={n} className={cn("h-1.5 flex-1 rounded-full", n <= stageIndex[a.activeIncident!.stage] ? "bg-escalating" : "bg-escalating/20")} />
            ))}
          </div>
        </div>
      ) : a.wellbeing === "SHIELD_PAUSED" ? (
        <div className="mt-4 rounded-xl bg-black/5 p-3 text-sm text-typography/60">
          Automated verification is inactive. Upgrade to resume protection.
        </div>
      ) : (
        <div className="mt-4 flex items-center justify-between text-sm">
          <div>
            <div className="label">Last seen well</div>
            <div className="font-medium">{relativeTime(a.lastConfirmationAt)}</div>
          </div>
          <div className="text-right">
            <div className="label">Streak</div>
            <div className="font-medium text-celebration">{a.vitalityStreak} days 🔥</div>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5">
        {a.personaModes.map((p) => (
          <span key={p} className="chip bg-black/5 text-typography/60">{p.replace(/_/g, " ").toLowerCase()}</span>
        ))}
      </div>
    </Link>
  );
}
