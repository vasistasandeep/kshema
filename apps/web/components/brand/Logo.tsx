import { cn } from "@/lib/cn";
export function Logo({ className, mark = true }: { className?: string; mark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      {mark && (
        <span className="relative inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary-action text-white">
          <span className="absolute inset-0 rounded-full bg-primary-action/40 animate-pulse-ring" />
          <span className="relative text-sm">◉</span>
        </span>
      )}
      <span>Kshema</span>
    </span>
  );
}
