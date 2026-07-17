"use client";

import { Command, Eye, EyeOff, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentUser, useLogoutMutation } from "../../hooks/api/useAuth";
import { getLinuxUsername, useIncognitoMode } from "../../lib/incognito";
import { Button } from "../ui/button";
import { NAVIGATION_ITEMS } from "./navigation";

interface TopBarProps {
	readonly onOpenCommandPalette: () => void;
}

export const TopBar = ({ onOpenCommandPalette }: TopBarProps) => {
	const { data: user } = useCurrentUser();
	const pathname = usePathname();
	const router = useRouter();
	const logoutMutation = useLogoutMutation();
	const [incognitoMode, setIncognitoMode] = useIncognitoMode();
	const context = NAVIGATION_ITEMS.find((item) => item.href === pathname) ?? {
		label: "Arr Control",
		description: "Media operations",
	};

	if (pathname === "/login") return null;

	const handleLogout = async () => {
		try {
			await logoutMutation.mutateAsync();
		} finally {
			router.replace("/login");
		}
	};

	return (
		<header className="sticky top-0 z-sticky flex min-h-16 items-center justify-between gap-4 border-b border-border/60 bg-background/85 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8">
			<div className="min-w-0 pl-12 lg:pl-0">
				<p className="hidden text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:block">
					Arr Control
				</p>
				<h2 className="truncate font-display text-lg font-semibold tracking-tight text-foreground">
					{context.label}
				</h2>
				<p className="hidden truncate text-sm text-muted-foreground md:block">
					{context.description}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onOpenCommandPalette}
					className="hidden min-w-44 justify-between text-muted-foreground md:inline-flex"
				>
					<span className="flex items-center gap-2">
						<Search className="h-4 w-4" />
						Search or jump to…
					</span>
					<kbd className="rounded border border-border/70 bg-muted px-1.5 py-0.5 text-[10px]">
						⌘K
					</kbd>
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					onClick={onOpenCommandPalette}
					className="md:hidden"
					aria-label="Search or jump to a page"
				>
					<Command className="h-4 w-4" />
				</Button>
				{!user ? (
					<Button asChild variant="secondary">
						<Link href="/login">Sign in</Link>
					</Button>
				) : (
					<>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => setIncognitoMode(!incognitoMode)}
							title={incognitoMode ? "Show real data" : "Hide sensitive data"}
							aria-label={incognitoMode ? "Show real data" : "Hide sensitive data"}
						>
							{incognitoMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
						</Button>
						<div className="hidden items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-2.5 py-1.5 sm:flex">
							<div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
								{(incognitoMode
									? getLinuxUsername(user.username)
									: user.username)[0]?.toUpperCase() ?? "U"}
							</div>
							<span className="max-w-28 truncate text-sm font-medium">
								{incognitoMode ? getLinuxUsername(user.username) : user.username}
							</span>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => void handleLogout()}
							disabled={logoutMutation.isPending}
							aria-busy={logoutMutation.isPending}
						>
							{logoutMutation.isPending ? "Signing out…" : "Sign out"}
						</Button>
					</>
				)}
			</div>
		</header>
	);
};
