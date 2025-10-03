'use client';

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../../lib/utils";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/discover", label: "Discover" },
  { href: "/library", label: "Library" },
  { href: "/search", label: "Search" },
  { href: "/indexers", label: "Indexers" },
  { href: "/calendar", label: "Calendar" },
  { href: "/statistics", label: "Statistics" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" },
];

export const Sidebar = () => {
  const pathname = usePathname();

  if (pathname === "/login") {
    return null;
  }

  return (
    <aside className="hidden w-64 flex-shrink-0 flex-col border-r border-white/10 bg-white/5 p-6 text-white/70 lg:flex">
      <div className="mb-10">
        <h1 className="text-xl font-semibold text-white">Arr Control Center</h1>
        <p className="mt-1 text-xs text-white/50">Centralized Management</p>
      </div>
      <nav className="flex flex-col gap-2">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "rounded-xl px-4 py-2 text-sm transition",
              pathname === item.href
                ? "bg-white/20 text-white"
                : "hover:bg-white/10 hover:text-white",
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
};
