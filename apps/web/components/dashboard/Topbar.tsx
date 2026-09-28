import { isDemoMode } from "@/lib/data";

export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-black/5 bg-white/50 px-5 py-4 sm:px-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-typography/60">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {isDemoMode && <span className="chip bg-celebration/15 text-celebration">Demo data</span>}
        <span className="chip bg-healthy/10 text-healthy"><span className="h-1.5 w-1.5 rounded-full bg-healthy" />Live</span>
      </div>
    </div>
  );
}
