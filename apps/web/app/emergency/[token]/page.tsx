/**
 * Ephemeral First-Responder Portal placeholder (R29).
 *
 * The zero-login, edge-rendered responder triage surface is implemented in the
 * emergency-portal task. This placeholder keeps the `/emergency/[token]` route
 * valid for the build.
 */
export default function EmergencyPortalPlaceholder(): JSX.Element {
  return (
    <main className="mx-auto max-w-md px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold">Kshema safety check</h1>
      <p className="mt-4 text-typography/70">
        This emergency view is preparing. If you reached this page in error, the
        safety check may have already concluded.
      </p>
    </main>
  );
}
