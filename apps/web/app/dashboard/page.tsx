import { AmbientDesk } from "./AmbientDesk";

/**
 * Observer dashboard home — Ambient Desk Mode (R28.5). Client-rendered so the
 * live SSE stream and dual-timezone clock update in place with no reload.
 */
export default function DashboardHome(): JSX.Element {
  return <AmbientDesk />;
}
