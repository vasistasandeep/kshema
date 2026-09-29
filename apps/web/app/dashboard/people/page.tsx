import { Topbar } from "@/components/dashboard/Topbar";
import { PeopleManager } from "@/components/dashboard/PeopleManager";

export default function PeoplePage() {
  return (
    <div>
      <Topbar title="People" subtitle="Add Anchors & Observers, invite family, manage roles" />
      <div className="mx-auto max-w-4xl px-5 py-6 sm:px-8">
        <PeopleManager />
      </div>
    </div>
  );
}
