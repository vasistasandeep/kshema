import { getSentinelPolicy, getHyperlocal, getDashboard } from "@/lib/data";
import { Topbar } from "@/components/dashboard/Topbar";
import { ConfigForms } from "@/components/dashboard/ConfigForms";

export default async function ConfigPage() {
  const [policy, hyperlocal, dash] = await Promise.all([getSentinelPolicy(), getHyperlocal(), getDashboard()]);
  return (
    <div>
      <Topbar title="Configure" subtitle="Sentinel policy, hyperlocal contacts & Circle members" />
      <div className="mx-auto max-w-4xl px-5 py-6 sm:px-8">
        <ConfigForms policy={policy} hyperlocal={hyperlocal} members={dash.circle.members} />
      </div>
    </div>
  );
}
