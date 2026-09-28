import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("chip", className)}>{children}</span>;
}
