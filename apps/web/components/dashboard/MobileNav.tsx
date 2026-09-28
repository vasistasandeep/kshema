"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const nav = [
  { href: "/dashboard", label: "Desk", icon: "◉" },
  { href: "/dashboard/anchors", label: "Anchors", icon: "👥" },
  { href: "/dashboard/vitality", label: "Vitality", icon: "🌸" },
  { href: "/dashboard/config", label: "Config", icon: "⚙️" },
  { href: "/dashboard/simulate", label: "Sim", icon: "🧪" },
];

export function MobileNav() {
  const path = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-black/5 bg-white/95 backdrop-blur lg:hidden">
      {nav.map((n) => {
        const active = n.href === "/dashboard" ? path === n.href : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href}
            className={cn("flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium",
              active ? "text-primary-action" : "text-typography/60")}>
            <span className="text-lg">{n.icon}</span>{n.label}
          </Link>
        );
      })}
    </nav>
  );
}
