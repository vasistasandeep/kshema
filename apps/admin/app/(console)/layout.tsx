import type { ReactNode } from "react";
import { ConsoleShell } from "./ConsoleShell";

/**
 * Layout for every authenticated console route. Wraps children in the
 * `AdminAuthGuard` shell (session gate + role-scoped nav + standing privacy
 * notice). The `/login` route lives outside this group and renders bare.
 */
export default function ConsoleLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return <ConsoleShell>{children}</ConsoleShell>;
}
