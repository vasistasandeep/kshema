"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { cn } from "@/lib/cn";

const nav = [
  { href: "/dashboard", label: "Ambient Desk", icon: "◉" },
  { href: "/dashboard/anchors", label: "Anchors", icon: "👥" },
  { href: "/dashboard/vitality", label: "Vitality", icon: "🌸" },
  { href: "/dashboard/config", label: "Configure", icon: "⚙️" },
  { href: "/dashboard/billing", label: "Billing", icon: "💳" },
  { href: "/dashboard/simulate", label: "Simulate", icon: "🧪" },
];

export function Sidebar() {
  const path = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-black/5 bg-white/60 px-3 py-5 lg:flex">
      <div className="px-3"><Logo /></div>
      <nav className="mt-8 flex flex-col gap-1">
        {nav.map((n) => {
          const active = n.href === "/dashboard" ? path === n.href : path.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href}
              className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                active ? "bg-primary-action/10 text-primary-action" : "text-typography/70 hover:bg-black/5")}>
              <span className="text-base">{n.icon}</span>{n.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto rounded-2xl bg-healthy/10 p-4 text-sm">
        <p className="font-semibold text-healthy">Circle protected</p>
        <p className="mt-1 text-typography/60">Trial · 9 days left</p>
        <Link href="/dashboard/billing" className="mt-2 inline-block text-xs font-semibold text-primary-action">Upgrade to Pro →</Link>
      </div>
    </aside>
  );
}
