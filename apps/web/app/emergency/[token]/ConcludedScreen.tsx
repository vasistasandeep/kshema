/**
 * Informational "the safety check has concluded" screen (R29.11).
 *
 * Rendered for expired, invalid, already-invalidated, or unreachable tokens.
 * It is deliberately calm and non-alarming: it never discloses WHY the token
 * is no longer valid (a resolved incident, expiry, or a bad link all look the
 * same to a responder), matching the API which never distinguishes the reason.
 *
 * Pure server component — no client JS required.
 */
export function ConcludedScreen({ message }: { message: string }): JSX.Element {
  return (
    <main className="wrap">
      <div className="card done">
        <div className="mark" aria-hidden="true">
          ✓
        </div>
        <h1>Safety check concluded</h1>
        <p>{message}</p>
      </div>
    </main>
  );
}
