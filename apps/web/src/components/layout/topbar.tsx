"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { EyeOff, Eye } from "lucide-react";
import { useCurrentUser, useLogoutMutation } from "../../hooks/api/useAuth";
import { useIncognitoMode } from "../../lib/incognito";
import { Button } from "../ui/button";

export const TopBar = () => {
	const { data: user } = useCurrentUser();
	const pathname = usePathname();
	const router = useRouter();
	const logoutMutation = useLogoutMutation();
	const [incognitoMode, setIncognitoMode] = useIncognitoMode();

	if (pathname === "/login") {
		return null;
	}

	const showLoginCta = !user;

	const handleLogout = async () => {
		try {
			await logoutMutation.mutateAsync();
			router.replace("/login");
		} catch (error) {
			console.error("Logout failed", error);
		}
	};

	return (
		<header className="flex items-center justify-between border-b border-border/30 bg-bg/80 backdrop-blur-xl px-6 py-4 shadow-sm">
			<div>
				<h2 className="text-lg font-semibold text-fg">Arr Control Center</h2>
				<p className="text-sm text-fg-muted">Manage Sonarr, Radarr, and Prowlarr from one place.</p>
			</div>
			<div className="flex items-center gap-3">
				{showLoginCta ? (
					<Button asChild variant="secondary">
						<Link href="/login">Sign in</Link>
					</Button>
				) : user ? (
					<>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIncognitoMode(!incognitoMode)}
							title={incognitoMode ? "Show real data" : "Hide sensitive data"}
							className="relative h-9 w-9 p-0"
						>
							{incognitoMode ? (
								<EyeOff className="h-4 w-4" />
							) : (
								<Eye className="h-4 w-4" />
							)}
						</Button>
						<div className="group relative flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-subtle/40 backdrop-blur-sm border border-border/50 hover:border-primary/30 transition-all duration-200 cursor-pointer">
							<div className="absolute inset-0 rounded-lg bg-gradient-to-r from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

							<div className="relative h-9 w-9 rounded-full bg-gradient-to-br from-primary to-accent text-white flex items-center justify-center shadow-md ring-1 ring-white/10">
								<span className="text-sm font-semibold">
									{user.username[0]?.toUpperCase() ?? "U"}
								</span>
							</div>
							<div className="text-right relative">
								<p className="text-sm font-medium text-fg">{user.username}</p>
							</div>
						</div>
						<Button
							variant="ghost"
							onClick={() => void handleLogout()}
							disabled={logoutMutation.isPending}
							aria-busy={logoutMutation.isPending}
						>
							{logoutMutation.isPending ? "Signing out..." : "Sign out"}
						</Button>
					</>
				) : (
					<div className="text-right">
						<p className="text-sm font-medium text-fg">Guest</p>
						<p className="text-xs text-fg-muted">Not signed in</p>
					</div>
				)}
			</div>
		</header>
	);
};
