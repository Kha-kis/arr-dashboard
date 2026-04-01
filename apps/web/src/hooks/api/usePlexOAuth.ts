"use client";

/**
 * Plex OAuth Setup Hook
 *
 * Manages the full Plex PIN-based OAuth flow:
 * 1. Opens popup to plex.tv auth page
 * 2. Polls backend for PIN approval
 * 3. Discovers available Plex servers
 * 4. Returns servers for user selection
 *
 * The popup is opened synchronously in the click handler to avoid browser popup blocking.
 */

import type { PlexDiscoveredServer } from "@arr/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPlexPin, discoverPlexServers, pollPlexPin } from "../../lib/api-client/plex";
import { getErrorMessage } from "../../lib/error-utils";

const PLEX_CLIENT_ID_KEY = "plex_client_id";
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 120_000;
const PLEX_AUTH_URL = "https://app.plex.tv/auth#!";

export type PlexOAuthStatus =
	| "idle"
	| "pending"
	| "polling"
	| "discovering"
	| "done"
	| "error"
	| "cancelled";

export interface UsePlexOAuthResult {
	status: PlexOAuthStatus;
	servers: PlexDiscoveredServer[];
	tokenRef: string | null;
	error: string | null;
	startOAuth: () => void;
	cancel: () => void;
}

/** Generate a v4-style UUID that works in non-secure contexts (plain HTTP). */
function generateUUID(): string {
	// crypto.randomUUID() requires a secure context (HTTPS).
	// Self-hosted apps often run on HTTP behind a reverse proxy, so fall back
	// to getRandomValues which works in all contexts.
	if (typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Get or create a persistent client identifier for Plex device registration. */
function getClientId(): string {
	const existing = localStorage.getItem(PLEX_CLIENT_ID_KEY);
	if (existing) return existing;
	const id = generateUUID();
	localStorage.setItem(PLEX_CLIENT_ID_KEY, id);
	return id;
}

export function usePlexOAuth(): UsePlexOAuthResult {
	const [status, setStatus] = useState<PlexOAuthStatus>("idle");
	const [servers, setServers] = useState<PlexDiscoveredServer[]>([]);
	const [tokenRef, setTokenRef] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const popupRef = useRef<Window | null>(null);
	const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const pollStartRef = useRef<number>(0);
	const abortRef = useRef(false);
	const pollInFlightRef = useRef(false);

	/** Clean up polling interval and popup. */
	const cleanup = useCallback(() => {
		if (pollIntervalRef.current) {
			clearInterval(pollIntervalRef.current);
			pollIntervalRef.current = null;
		}
		if (popupRef.current && !popupRef.current.closed) {
			popupRef.current.close();
		}
		popupRef.current = null;
	}, []);

	// Cleanup on unmount
	useEffect(() => cleanup, [cleanup]);

	const cancel = useCallback(() => {
		abortRef.current = true;
		pollInFlightRef.current = false;
		cleanup();
		setStatus("idle");
		setError(null);
	}, [cleanup]);

	const startOAuth = useCallback(() => {
		// Guard against double-start
		if (status !== "idle" && status !== "error" && status !== "cancelled" && status !== "done") {
			return;
		}

		abortRef.current = false;
		pollInFlightRef.current = false;
		setError(null);
		setServers([]);
		setTokenRef(null);
		setStatus("pending");

		const clientId = getClientId();

		// Open popup immediately (synchronous, in click handler) to avoid popup blocking.
		// Centered 600x700 window.
		const width = 600;
		const height = 700;
		const left = window.screenX + (window.innerWidth - width) / 2;
		const top = window.screenY + (window.innerHeight - height) / 2;
		const popup = window.open(
			"about:blank",
			"plex-oauth",
			`width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`,
		);

		if (!popup) {
			setStatus("error");
			setError(
				"Popup was blocked by your browser. Please allow popups for this site and try again.",
			);
			return;
		}

		popupRef.current = popup;

		// Now create the PIN asynchronously, then redirect the popup
		(async () => {
			try {
				const { pinId, pinCode } = await createPlexPin(clientId);

				if (abortRef.current) return;

				// Redirect popup to Plex auth page
				const authParams = new URLSearchParams({
					clientID: clientId,
					code: pinCode,
					"context[device][product]": "Arr Control Center",
					"context[device][layout]": "desktop",
				});
				popup.location.href = `${PLEX_AUTH_URL}?${authParams.toString()}`;

				setStatus("polling");
				pollStartRef.current = Date.now();

				// Start polling for token
				pollIntervalRef.current = setInterval(async () => {
					// Skip if a previous poll request is still in flight
					if (pollInFlightRef.current) return;

					// Timeout check
					if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
						cleanup();
						setStatus("error");
						setError("Plex authentication timed out. Please try again.");
						return;
					}

					pollInFlightRef.current = true;
					try {
						const { tokenRef: receivedRef } = await pollPlexPin(pinId, clientId);

						// Check popup closed AFTER polling — the user may have closed
						// the popup after approving (Plex says "you can close this window")
						if (!receivedRef) {
							if (popupRef.current?.closed) {
								cleanup();
								setStatus("cancelled");
							}
							return;
						}

						// Token stored server-side — stop polling
						cleanup();

						if (abortRef.current) return;
						setTokenRef(receivedRef);
						setStatus("discovering");

						// Discover servers using server-side token ref
						try {
							const { servers: discovered } = await discoverPlexServers(receivedRef, clientId);

							if (abortRef.current) return;
							setServers(discovered);
							setStatus("done");
						} catch (discoverErr: unknown) {
							if (!abortRef.current) {
								setStatus("error");
								setError(getErrorMessage(discoverErr, "Failed to discover Plex servers"));
							}
						}
					} catch {
						// Poll-check errors are transient — the interval will retry on next tick.
						// Discovery errors are handled in the inner try-catch above.
					} finally {
						pollInFlightRef.current = false;
					}
				}, POLL_INTERVAL_MS);
			} catch (err: unknown) {
				cleanup();
				if (!abortRef.current) {
					setStatus("error");
					setError(getErrorMessage(err, "Failed to start Plex authentication"));
				}
			}
		})();
	}, [status, cleanup]);

	return { status, servers, tokenRef, error, startOAuth, cancel };
}
