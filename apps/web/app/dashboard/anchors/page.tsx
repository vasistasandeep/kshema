import { getDashboard } from "@/lib/data";
import { Topbar } from "@/components/dashboard/Topbar";
import { AnchorCard } from "@/components/dashboard/AnchorCard";

export default async function AnchorsPage() {
  const d = await getDashboard();
  return (
    <div>
      <Topbar title="Anchors" subtitle="Everyone your Circle watches over" />
      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {d.anchors.map((a) => <AnchorCard key={a.id} a={a} />)}
        </div>
      </div>
    </div>
  );
}
