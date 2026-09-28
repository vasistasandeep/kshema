import { EmergencyCard } from "@/components/anchor/EmergencyCard";
import { hyperlocalProfile, anchors } from "@/lib/mock/data";

export default function EmergencyPortal({ params }: { params: { token: string } }) {
  const valid = params.token && params.token.length > 6 && params.token !== "expired";
  if (!valid) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-deep-charcoal px-6 text-center text-white">
        <div>
          <h1 className="text-2xl font-semibold">This safety check has concluded</h1>
          <p className="mt-2 text-white/60">The link is no longer active. Thank you for helping.</p>
        </div>
      </main>
    );
  }
  const anchor = anchors[1];
  return <EmergencyCard anchorName={anchor.preferredName} profile={hyperlocalProfile} />;
}
