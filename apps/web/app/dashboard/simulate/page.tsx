import { Topbar } from "@/components/dashboard/Topbar";
import { Simulator } from "@/components/dashboard/Simulator";

export default function SimulatePage() {
  return (
    <div>
      <Topbar title="Simulate" subtitle="Drive the full safety pipeline — no phone required (R25)" />
      <div className="mx-auto max-w-4xl px-5 py-6 sm:px-8">
        <Simulator />
      </div>
    </div>
  );
}
