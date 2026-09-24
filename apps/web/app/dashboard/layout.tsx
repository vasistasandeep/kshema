import type { ReactNode } from "react";
import { PortalShell } from "./PortalShell";

/**
 * Observer dashboard layout. Wraps every `/dashboard/*` page except the login
 * route in the authenticated shell (session guard + 30-minute idle lock). The
 * login page renders outside this shell via its own segment.
 */
export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return <PortalShell>{children}</PortalShell>;
}
