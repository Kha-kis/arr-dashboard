"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../../lib/utils";
import { useState } from "react";
import { Menu, X } from "lucide-react";

const NAV_ITEMS = [
	{ href: "/dashboard", label: "Dashboard" },
	{ href: "/discover", label: "Discover" },
	{ href: "/library", label: "Library" },
	{ href: "/search", label: "Search" },
	{ href: "/indexers", label: "Indexers" },
	{ href: "/calendar", label: "Calendar" },
	{ href: "/statistics", label: "Statistics" },
	{ href: "/history", label: "History" },
	{ href: "/custom-formats", label: "Custom Formats" },
	{ href: "/arr-sync", label: "ARR Sync" },
	{ href: "/settings", label: "Settings" },
];

export const Sidebar = () => {
	const pathname = usePathname();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

	if (pathname === "/login" || pathname === "/setup") {
		return null;
	}

	const NavContent = () => (
		<>
			<div className="mb-10 relative z-10">
				<h1 className="text-xl font-semibold gradient-text">Arr Control Center</h1>
				<p className="mt-1 text-xs text-fg-muted">Centralized Management</p>
			</div>

			<nav className="flex flex-col gap-2 relative z-10">
				{NAV_ITEMS.map((item) => (
					<Link
						key={item.href}
						href={item.href}
						onClick={() => setMobileMenuOpen(false)}
						className={cn(
							"group relative rounded-xl px-4 py-2 text-sm transition-all duration-200",
							pathname === item.href
								? "bg-primary text-white shadow-lg shadow-primary/20"
								: "hover:bg-bg-subtle/50 hover:text-fg",
						)}
					>
						{/* Hover glow effect */}
						<div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-r from-primary/10 to-transparent pointer-events-none" />

						<span className="relative z-10">{item.label}</span>
					</Link>
				))}
			</nav>
		</>
	);

	return (
		<>
			{/* Mobile menu button */}
			<button
				onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
				className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-bg-subtle/90 backdrop-blur-xl border border-border/50 text-fg hover:bg-bg-muted transition-colors"
				aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
				aria-expanded={mobileMenuOpen}
			>
				{mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
			</button>

			{/* Mobile menu overlay */}
			{mobileMenuOpen && (
				<div
					className="lg:hidden fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
					onClick={() => setMobileMenuOpen(false)}
					aria-hidden="true"
				/>
			)}

			{/* Mobile sidebar */}
			<aside
				className={cn(
					"lg:hidden fixed inset-y-0 left-0 z-40 w-72 flex flex-col border-r border-border/30 bg-bg/95 backdrop-blur-xl p-6 text-fg-muted transition-transform duration-300",
					mobileMenuOpen ? "translate-x-0" : "-translate-x-full",
				)}
			>
				{/* Decorative gradient orb */}
				<div className="absolute top-0 left-0 w-48 h-48 bg-primary/5 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2 pointer-events-none" />

				<NavContent />
			</aside>

			{/* Desktop sidebar */}
			<aside className="hidden w-64 flex-shrink-0 flex-col border-r border-border/30 bg-bg/50 backdrop-blur-xl p-6 text-fg-muted lg:flex relative">
				{/* Decorative gradient orb */}
				<div className="absolute top-0 left-0 w-48 h-48 bg-primary/5 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2 pointer-events-none" />

				<NavContent />
			</aside>
		</>
	);
};
