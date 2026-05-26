"use client";

/**
 * App-wide qui SSE stream lifecycle (Phase 5.2).
 *
 * Owns ONE EventSource per browser tab. Previously `useQuiEventStream`
 * was called from `qui-activity-client.tsx` only — so the live-channel
 * push freshness only affected the activity surface; the library badges,
 * Torrent Health panel, and Cross-Seed page kept using their React Query
 * polling intervals as if Phase 5.2 hadn't shipped.
 *
 * Mounting the stream here, gated on (a) user is authenticated and
 * (b) a qui instance is configured, gives the entire dashboard push-
 * driven invalidation while still avoiding wasted sockets for users
 * who'll never receive events.
 *
 * Consumers needing the connection status (e.g., the "Live channel
 * offline" pill on the qui-activity page) read `useQuiStreamStatus()`
 * — they don't open their own EventSource, so we keep the one-socket
 * invariant.
 */

import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext } from "react";
import { useCurrentUser } from "../hooks/api/useAuth";
import { type QuiEventStreamStatus, useQuiEventStream } from "../hooks/api/useQui";
import { useServicesQuery } from "../hooks/api/useServicesQuery";

/**
 * Same public-route set used by `AuthGate`. We mirror it here so the
 * provider doesn't fire `/auth/me` (or `/api/services`) on `/login` /
 * `/setup` pages — those would 401 noisily and add useless network
 * traffic to the unauthenticated UX.
 */
const PUBLIC_ROUTES = new Set(["/login", "/setup"]);

interface QuiStreamContextValue {
	streamStatus: QuiEventStreamStatus;
	/** True if the provider is actively running the EventSource (vs. gated off
	 * because the user has no qui instance or isn't authenticated). When
	 * false, `streamStatus` will be "offline" but that doesn't mean the
	 * channel is broken — it means the channel isn't applicable. */
	isActive: boolean;
}

const QuiStreamContext = createContext<QuiStreamContextValue>({
	streamStatus: "offline",
	isActive: false,
});

export const QuiStreamProvider = ({ children }: { children: ReactNode }) => {
	// Gate every downstream fetch on three conditions:
	//   1. We're NOT on a public route (login/setup). Without this gate the
	//      provider would fire `/auth/me` on the login page itself — a
	//      guaranteed 401 that pollutes the console and contradicts the
	//      gating AuthGate already does for the rest of the tree.
	//   2. The user is authenticated. Without a session cookie the SSE
	//      route returns 401 + EventSource auto-retries forever; no benefit
	//      to opening it. `useCurrentUser()` returns null when unauthenticated.
	//   3. The user has at least one qui instance. With no qui configured,
	//      qui will never POST to /webhooks/qui for this user, so the
	//      stream would be a permanently-idle socket.
	const pathname = usePathname();
	const isPublicRoute = PUBLIC_ROUTES.has(pathname ?? "");

	const { data: user } = useCurrentUser(!isPublicRoute);
	const { data: services } = useServicesQuery({ enabled: !isPublicRoute && Boolean(user) });
	const hasQui = Boolean(services?.some((s) => s.service === "qui" && s.enabled));

	const enabled = !isPublicRoute && Boolean(user) && hasQui;
	const { streamStatus } = useQuiEventStream({ enabled });

	return (
		<QuiStreamContext.Provider value={{ streamStatus, isActive: enabled }}>
			{children}
		</QuiStreamContext.Provider>
	);
};

/** Read the app-wide qui SSE status. Returns `{streamStatus, isActive}`. */
export const useQuiStreamStatus = () => useContext(QuiStreamContext);
