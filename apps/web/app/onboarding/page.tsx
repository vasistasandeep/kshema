import { Suspense } from "react";
import { OnboardingFlow } from "@/components/anchor/OnboardingFlow";
export default function OnboardingPage() {
  return (
    <main className="min-h-screen">
      <Suspense fallback={<div className="p-8 text-typography/50">Loading…</div>}>
        <OnboardingFlow />
      </Suspense>
    </main>
  );
}
