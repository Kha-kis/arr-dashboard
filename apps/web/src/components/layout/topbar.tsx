"use client";

import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentUser, useLogoutMutation } from "../../hooks/api/useAuth";
import { getLinuxUsername, useIncognitoMode } from "../../lib/incognito";
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
		<header className="flex min-w-0 items-center justify-end border-b border-border/30 bg-background/80 py-3 pl-16 pr-3 shadow-sm backdrop-blur-xl sm:px-6 sm:py-4 sm:pl-16 lg:justify-between lg:pl-6">
			<div className="hidden min-w-0 lg:block">
				<h2 className="text-lg font-semibold text-foreground">Arr Control Center</h2>
				<p className="text-sm text-muted-foreground">
					Manage Sonarr, Radarr, and Prowlarr from one place.
				</p>
			</div>
			<div className="flex min-w-0 items-center gap-1 sm:gap-3">
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
							{incognitoMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
						</Button>
						<div className="group relative flex min-w-0 items-center gap-2 rounded-lg border border-border/50 bg-card/40 p-1.5 backdrop-blur-xs transition-all duration-200 hover:border-primary/30 sm:gap-3 sm:px-3 sm:py-2">
							<div className="absolute inset-0 rounded-lg bg-linear-to-r from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

							<div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-primary to-accent text-white shadow-md ring-1 ring-white/10 sm:h-9 sm:w-9">
								<span className="text-sm font-semibold">
									{(incognitoMode
										? getLinuxUsername(user.username)
										: user.username)[0]?.toUpperCase() ?? "U"}
								</span>
							</div>
							<div className="relative hidden min-w-0 max-w-40 text-right sm:block">
								<p className="truncate text-sm font-medium text-foreground">
									{incognitoMode ? getLinuxUsername(user.username) : user.username}
								</p>
							</div>
						</div>
						<Button
							variant="ghost"
							onClick={() => void handleLogout()}
							disabled={logoutMutation.isPending}
							aria-busy={logoutMutation.isPending}
							className="h-8 px-2 text-xs sm:h-10 sm:px-4 sm:text-sm"
						>
							{logoutMutation.isPending ? "Signing out..." : "Sign out"}
						</Button>
					</>
				) : (
					<div className="text-right">
						<p className="text-sm font-medium text-foreground">Guest</p>
						<p className="text-xs text-muted-foreground">Not signed in</p>
					</div>
				)}
			</div>
		</header>
	);
};
