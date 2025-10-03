'use client';

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentUser, useLogoutMutation } from "../../hooks/api/useAuth";
import { Button } from "../ui/button";

export const TopBar = () => {
  const { data: user } = useCurrentUser();
  const pathname = usePathname();
  const router = useRouter();
  const logoutMutation = useLogoutMutation();

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
    <header className="flex items-center justify-between border-b border-white/10 bg-white/5 px-6 py-4 text-white/80">
      <div>
        <h2 className="text-lg font-semibold text-white">Arr Control Center</h2>
        <p className="text-sm text-white/60">Manage Sonarr, Radarr, and Prowlarr from one place.</p>
      </div>
      <div className="flex items-center gap-3">
        {showLoginCta ? (
          <Button asChild variant="secondary">
            <Link href="/login">Sign in</Link>
          </Button>
        ) : user ? (
          <>
            <div className="h-10 w-10 rounded-full bg-white/10" />
            <div className="text-right">
              <p className="text-sm font-medium text-white">{user.username}</p>
              <p className="text-xs text-white/60">{user.email}</p>
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
            <p className="text-sm font-medium text-white">Guest</p>
            <p className="text-xs text-white/60">Not signed in</p>
          </div>
        )}
      </div>
    </header>
  );
};

