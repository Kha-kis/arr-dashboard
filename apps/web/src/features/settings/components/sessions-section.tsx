"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui";
import { Button } from "../../../components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import {
	type DeviceType,
	type SessionInfo,
	type SessionsResponse,
	getSessions,
	revokeSession,
} from "../../../lib/api-client/auth";

/**
 * Device type icon component
 */
const DeviceIcon = ({ device, className }: { device: DeviceType; className?: string }) => {
	switch (device) {
		case "mobile":
			return (
				<svg
					className={className}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
					/>
				</svg>
			);
		case "tablet":
			return (
				<svg
					className={className}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
					/>
				</svg>
			);
		default: // desktop or unknown
			return (
				<svg
					className={className}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
					/>
				</svg>
			);
	}
};

/**
 * Sessions management section for account settings
 * Displays all active sessions for the current user with device info and revoke functionality
 */
export const SessionsSection = () => {
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [totalSessions, setTotalSessions] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [revokingId, setRevokingId] = useState<string | null>(null);

	const loadSessions = useCallback(async (isRefresh = false) => {
		try {
			if (isRefresh) {
				setRefreshing(true);
			}
			setError(null);
			const data: SessionsResponse = await getSessions();
			setSessions(data.sessions);
			setTotalSessions(data.totalSessions);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load sessions");
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, []);

	const handleRevoke = async (sessionId: string) => {
		setRevokingId(sessionId);
		setError(null);
		try {
			await revokeSession(sessionId);
			// Reload sessions after successful revocation
			await loadSessions(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to revoke session");
		} finally {
			setRevokingId(null);
		}
	};

	useEffect(() => {
		loadSessions();
	}, [loadSessions]);

	const formatDate = (dateString: string) => {
		const date = new Date(dateString);
		return date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	};

	const getRelativeTime = (dateString: string) => {
		const date = new Date(dateString);
		const now = Date.now();
		const diff = now - date.getTime();

		const minutes = Math.floor(diff / (1000 * 60));
		const hours = Math.floor(diff / (1000 * 60 * 60));
		const days = Math.floor(diff / (1000 * 60 * 60 * 24));

		if (minutes < 1) return "Just now";
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days < 7) return `${days}d ago`;
		return formatDate(dateString);
	};

	const getTimeRemaining = (expiresAt: string) => {
		const now = Date.now();
		const expiry = new Date(expiresAt).getTime();
		const remaining = expiry - now;

		if (remaining <= 0) return "Expired";

		const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
		const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

		if (days > 0) return `${days}d ${hours}h remaining`;
		if (hours > 0) return `${hours}h remaining`;

		const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
		return `${minutes}m remaining`;
	};

	const getDeviceLabel = (session: SessionInfo) => {
		// Use parsed browser/OS info if available
		if (session.browser && session.os && session.browser !== "Unknown") {
			return `${session.browser} on ${session.os}`;
		}
		// Fallback to generic device type label
		switch (session.device) {
			case "mobile":
				return "Mobile Device";
			case "tablet":
				return "Tablet";
			case "desktop":
				return "Desktop";
			default:
				return "Unknown Device";
		}
	};

	if (loading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Active Sessions</CardTitle>
					<CardDescription>Loading session information...</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>Active Sessions</CardTitle>
						<CardDescription>
							View and manage all devices where you&apos;re currently signed in. You can revoke
							access for any session except your current one.
						</CardDescription>
					</div>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => loadSessions(true)}
						disabled={refreshing}
					>
						{refreshing ? "Refreshing..." : "Refresh"}
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-6">
				{/* Error Message */}
				{error && (
					<Alert variant="danger">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}

				{/* Session Count Summary */}
				<div className="rounded-lg border border-border bg-bg-subtle p-4">
					<div className="flex items-center gap-3">
						<div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20">
							<svg
								className="h-5 w-5 text-primary"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
								/>
							</svg>
						</div>
						<div>
							<p className="text-2xl font-bold text-fg">{totalSessions}</p>
							<p className="text-sm text-fg-muted">
								{totalSessions === 1 ? "Active session" : "Active sessions"}
							</p>
						</div>
					</div>
				</div>

				{/* Session List */}
				{sessions.length > 0 ? (
					<div className="space-y-4">
						<h3 className="text-sm font-semibold text-fg">Session Details</h3>
						<div className="space-y-3">
							{sessions.map((session) => (
								<div
									key={session.id}
									className={`rounded-lg border p-4 ${
										session.isCurrent
											? "border-primary bg-primary/10"
											: session.isExpired
												? "border-red-500/50 bg-red-500/10"
												: "border-border bg-bg-subtle"
									}`}
								>
									<div className="flex items-start justify-between gap-4">
										{/* Left: Device info */}
										<div className="flex items-start gap-3 min-w-0 flex-1">
											<div
												className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${
													session.isCurrent
														? "bg-primary/30"
														: session.isExpired
															? "bg-red-500/30"
															: "bg-bg"
												}`}
											>
												<DeviceIcon
													device={session.device}
													className={`h-5 w-5 ${
														session.isCurrent
															? "text-primary"
															: session.isExpired
																? "text-red-400"
																: "text-fg-muted"
													}`}
												/>
											</div>
											<div className="min-w-0 flex-1">
												<div className="flex flex-wrap items-center gap-2">
													<p className="text-sm font-medium text-fg truncate">
														{getDeviceLabel(session)}
													</p>
													{session.isCurrent && (
														<span className="rounded bg-primary/30 px-2 py-0.5 text-xs font-medium text-primary flex-shrink-0">
															Current
														</span>
													)}
													{session.isExpired && (
														<span className="rounded bg-red-500/30 px-2 py-0.5 text-xs font-medium text-red-400 flex-shrink-0">
															Expired
														</span>
													)}
												</div>
												{/* IP Address */}
												{session.ipAddress && (
													<p className="mt-1 text-xs text-fg-muted">IP: {session.ipAddress}</p>
												)}
												{/* Time info */}
												<div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
													<span>Created: {formatDate(session.createdAt)}</span>
													<span>Last active: {getRelativeTime(session.lastAccessedAt)}</span>
												</div>
											</div>
										</div>

										{/* Right: Expiry and actions */}
										<div className="flex flex-col items-end gap-2 flex-shrink-0">
											<div className="text-right">
												<p
													className={`text-sm font-medium ${
														session.isExpired ? "text-red-400" : "text-fg-muted"
													}`}
												>
													{getTimeRemaining(session.expiresAt)}
												</p>
											</div>
											{/* Revoke button - only show for non-current sessions */}
											{!session.isCurrent && (
												<Button
													variant="danger"
													size="sm"
													onClick={() => handleRevoke(session.id)}
													disabled={revokingId === session.id}
												>
													{revokingId === session.id ? "Revoking..." : "Revoke"}
												</Button>
											)}
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				) : (
					<div className="rounded-lg border border-border bg-bg-subtle p-6 text-center">
						<svg
							className="mx-auto h-12 w-12 text-fg-muted"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
							/>
						</svg>
						<p className="mt-4 text-sm text-fg-muted">No active sessions found</p>
					</div>
				)}

				{/* Info Box */}
				<div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4">
					<div className="flex gap-3">
						<svg
							className="h-5 w-5 flex-shrink-0 text-sky-400"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
							/>
						</svg>
						<div className="text-sm text-sky-300">
							<p className="font-medium">Session Security</p>
							<p className="mt-1 text-sky-300/80">
								If you see sessions you don&apos;t recognize, revoke them immediately and consider
								changing your password. Each session shows the browser, operating system, and IP
								address used at login time.
							</p>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
};
