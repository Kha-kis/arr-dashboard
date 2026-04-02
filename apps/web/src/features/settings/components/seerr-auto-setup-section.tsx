"use client";

/**
 * Seerr Auto-Setup Section
 *
 * Inline component shown in ServiceForm for Seerr services (add and edit mode).
 * Uses Plex sign-in to authenticate to Seerr and retrieve the API key automatically.
 * Requires the user to enter the Seerr Base URL first.
 */

import { Loader2, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui";
import { usePlexOAuth } from "../../../hooks/api/usePlexOAuth";
import { fetchSeerrApiKey } from "../../../lib/api-client/seerr";
import { getErrorMessage } from "../../../lib/error-utils";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const SEERR_GRADIENT = SERVICE_GRADIENTS.seerr;

interface SeerrAutoSetupSectionProps {
	seerrUrl: string;
	onApiKeyFetched: (apiKey: string) => void;
	onTestConnection: () => void;
	mode: "add" | "edit";
}

type SetupStatus = "idle" | "plex-auth" | "fetching" | "done" | "error";

export const SeerrAutoSetupSection = ({
	seerrUrl,
	onApiKeyFetched,
	onTestConnection,
	mode,
}: SeerrAutoSetupSectionProps) => {
	const isEdit = mode === "edit";
	const { status: plexStatus, tokenRef, startOAuth, cancel: cancelPlex } = usePlexOAuth();
	const [setupStatus, setSetupStatus] = useState<SetupStatus>("idle");
	const [error, setError] = useState<string | null>(null);

	const fetchKey = useCallback(
		async (ref: string) => {
			if (!seerrUrl.trim()) {
				setSetupStatus("error");
				setError("Seerr Base URL was cleared. Please enter a URL and try again.");
				return;
			}
			setSetupStatus("fetching");
			setError(null);
			try {
				const { apiKey } = await fetchSeerrApiKey(seerrUrl.trim(), ref);
				onApiKeyFetched(apiKey);
				setSetupStatus("done");
				setTimeout(onTestConnection, 100);
			} catch (err: unknown) {
				setSetupStatus("error");
				setError(getErrorMessage(err, "Failed to retrieve Seerr API key"));
			}
		},
		[seerrUrl, onApiKeyFetched, onTestConnection],
	);

	const handleConnect = useCallback(() => {
		if (!seerrUrl.trim()) {
			setError("Enter the Seerr Base URL first.");
			setSetupStatus("error");
			return;
		}

		// If we already have a Plex token, skip straight to fetching the key
		if (tokenRef) {
			fetchKey(tokenRef);
			return;
		}

		// Otherwise, start Plex OAuth — we'll fetch the key after it completes
		setSetupStatus("plex-auth");
		setError(null);
		startOAuth();
	}, [seerrUrl, tokenRef, fetchKey, startOAuth]);

	// Bridge Plex OAuth completion → Seerr key fetch
	const prevTokenRef = useRef<string | null>(null);
	useEffect(() => {
		if (tokenRef && tokenRef !== prevTokenRef.current && setupStatus === "plex-auth") {
			prevTokenRef.current = tokenRef;
			fetchKey(tokenRef);
		}
	}, [tokenRef, setupStatus, fetchKey]);

	// Bridge Plex OAuth failures → surface to Seerr setup status
	useEffect(() => {
		if (setupStatus !== "plex-auth") return;
		if (plexStatus === "error") {
			setSetupStatus("error");
			setError("Plex authentication failed. Please try again.");
		}
		if (plexStatus === "cancelled") {
			setSetupStatus("idle");
		}
	}, [plexStatus, setupStatus]);

	const handleCancel = useCallback(() => {
		cancelPlex();
		setSetupStatus("idle");
		setError(null);
	}, [cancelPlex]);

	const needsUrl = !seerrUrl.trim();

	// Idle / error / done — show the connect button
	if (setupStatus === "idle" || setupStatus === "error" || setupStatus === "done") {
		return (
			<div className="space-y-3">
				<button
					type="button"
					onClick={handleConnect}
					disabled={needsUrl}
					className="flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
					style={{
						borderColor: SEERR_GRADIENT.from,
						backgroundColor: `${SEERR_GRADIENT.from}15`,
						color: SEERR_GRADIENT.from,
					}}
				>
					<Server className="h-4 w-4" />
					{isEdit ? "Re-authenticate Seerr with Plex" : "Sign in to Seerr with Plex"}
				</button>

				{needsUrl && (
					<p className="text-center text-xs text-muted-foreground">
						Enter the Seerr Base URL above first.
					</p>
				)}

				{setupStatus === "error" && error && (
					<Alert variant="danger">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}

				{setupStatus === "done" && (
					<Alert variant="success">
						<AlertDescription>
							{isEdit
								? "API key updated — click Save changes to apply."
								: "API key retrieved successfully."}
						</AlertDescription>
					</Alert>
				)}

				<Divider text={isEdit ? "or edit manually" : "or enter manually"} />
			</div>
		);
	}

	// Plex auth in progress or fetching key
	if (setupStatus === "plex-auth" || setupStatus === "fetching") {
		return (
			<div className="space-y-3">
				<div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-card/30 px-3 py-2.5 sm:px-4 sm:py-3">
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" style={{ color: SEERR_GRADIENT.from }} />
						{setupStatus === "plex-auth" && plexStatus === "pending" && "Connecting to Plex..."}
						{setupStatus === "plex-auth" &&
							plexStatus === "polling" &&
							"Waiting for Plex authorization..."}
						{setupStatus === "plex-auth" && plexStatus === "discovering" && "Plex authorized..."}
						{setupStatus === "fetching" && "Fetching Seerr API key..."}
						{setupStatus === "plex-auth" &&
							plexStatus !== "pending" &&
							plexStatus !== "polling" &&
							plexStatus !== "discovering" &&
							"Connecting to Plex..."}
					</div>
					<button
						type="button"
						onClick={handleCancel}
						className="text-xs text-muted-foreground hover:text-foreground"
					>
						Cancel
					</button>
				</div>

				<Divider text={isEdit ? "or edit manually" : "or enter manually"} />
			</div>
		);
	}

	return null;
};

/** Visual divider with configurable text */
const Divider = ({ text = "or enter manually" }: { text?: string }) => (
	<div className="relative">
		<div className="absolute inset-0 flex items-center">
			<span className="w-full border-t border-border" />
		</div>
		<div className="relative flex justify-center text-xs uppercase">
			<span className="bg-card px-2 text-muted-foreground">{text}</span>
		</div>
	</div>
);
