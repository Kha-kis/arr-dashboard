"use client";

import { useCallback, useEffect, useState } from "react";
import {
	Monitor,
	Smartphone,
	Tablet,
	RefreshCw,
	Clock,
	Wifi,
	AlertCircle,
	Shield,
	Check,
	X,
	Loader2,
	Info,
} from "lucide-react";
import { Button } from "../../../components/ui/button";
import { PremiumSection, GlassmorphicCard, PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	type DeviceType,
	type SessionInfo,
	type SessionsResponse,
	getSessions,
	revokeSession,
} from "../../../lib/api-client/auth";
import { cn } from "../../../lib/utils";
import { getErrorMessage } from "../../../lib/error-utils";

/**
 * Device type icon component using lucide-react
 */
const DeviceIcon = ({
	device,
	className,
	style,
}: {
	device: DeviceType;
	className?: string;
	style?: React.CSSProperties;
}) => {
	switch (device) {
		case "mobile":
			return <Smartphone className={className} style={style} />;
		case "tablet":
			return <Tablet className={className} style={style} />;
		default:
			return <Monitor className={className} style={style} />;
	}
};

/**
 * Premium Sessions Section
 *
 * Session management with:
 * - Glassmorphic session cards
 * - Device-specific icons
 * - Theme-aware styling
 * - Staggered animations
 */
export const SessionsSection = () => {
	const { gradient: themeGradient } = useThemeGradient();

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
			setError(getErrorMessage(err, "Failed to load sessions"));
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
			await loadSessions(true);
		} catch (err) {
			setError(getErrorMessage(err, "Failed to revoke session"));
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
		if (session.browser && session.os && session.browser !== "Unknown") {
			return `${session.browser} on ${session.os}`;
		}
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
			<PremiumSection
				title="Active Sessions"
				description="Loading session information..."
				icon={Shield}
			>
				<div className="space-y-4">
					<PremiumSkeleton className="h-24" />
					<PremiumSkeleton className="h-32" />
				</div>
			</PremiumSection>
		);
	}

	return (
		<PremiumSection
			title="Active Sessions"
			description="View and manage all devices where you're currently signed in. You can revoke access for any session except your current one."
			icon={Shield}
			actions={
				<Button
					variant="outline"
					size="sm"
					onClick={() => loadSessions(true)}
					disabled={refreshing}
					className="gap-1.5"
				>
					<RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
					{refreshing ? "Refreshing..." : "Refresh"}
				</Button>
			}
		>
			<div className="space-y-6">
				{/* Error Message */}
				{error && (
					<div
						className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							color: SEMANTIC_COLORS.error.text,
						}}
					>
						<X className="h-4 w-4 shrink-0" />
						<span>{error}</span>
					</div>
				)}

				{/* Session Count Summary */}
				<GlassmorphicCard padding="md">
					<div className="flex items-center gap-4">
						<div
							className="flex h-14 w-14 items-center justify-center rounded-2xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Monitor className="h-7 w-7" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<p
								className="text-3xl font-bold"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
								}}
							>
								{totalSessions}
							</p>
							<p className="text-sm text-muted-foreground">
								{totalSessions === 1 ? "Active session" : "Active sessions"}
							</p>
						</div>
					</div>
				</GlassmorphicCard>

				{/* Session List */}
				<GlassmorphicCard padding="lg">
					<div className="space-y-4">
						<div className="flex items-center gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Shield className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div>
								<h3 className="font-semibold text-foreground">Session Details</h3>
								<p className="text-xs text-muted-foreground">
									All currently active sessions for your account
								</p>
							</div>
						</div>

						{sessions.length > 0 ? (
							<div className="space-y-3">
								{sessions.map((session, index) => {
									const isCurrentSession = session.isCurrent;
									const isExpired = session.isExpired;

									return (
										<div
											key={session.id}
											className={cn(
												"rounded-xl border p-4 transition-all duration-300 animate-in fade-in slide-in-from-bottom-2",
												isCurrentSession
													? "border-transparent"
													: isExpired
														? "border-transparent"
														: "border-border/50 bg-card/30 hover:border-border/80"
											)}
											style={{
												animationDelay: `${index * 50}ms`,
												animationFillMode: "backwards",
												...(isCurrentSession && {
													background: `linear-gradient(135deg, ${themeGradient.from}10, ${themeGradient.to}10)`,
													border: `1px solid ${themeGradient.from}30`,
												}),
												...(isExpired && {
													background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}10, ${SEMANTIC_COLORS.error.to}10)`,
													border: `1px solid ${SEMANTIC_COLORS.error.from}30`,
												}),
											}}
										>
											<div className="flex items-start justify-between gap-4">
												{/* Left: Device info */}
												<div className="flex items-start gap-3 min-w-0 flex-1">
													<div
														className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
														style={{
															background: isCurrentSession
																? `linear-gradient(135deg, ${themeGradient.from}30, ${themeGradient.to}30)`
																: isExpired
																	? `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}20, ${SEMANTIC_COLORS.error.to}20)`
																	: "rgba(var(--card), 0.5)",
															border: isCurrentSession
																? `1px solid ${themeGradient.from}40`
																: isExpired
																	? `1px solid ${SEMANTIC_COLORS.error.from}30`
																	: "1px solid rgba(var(--border), 0.5)",
														}}
													>
														<DeviceIcon
															device={session.device}
															className="h-5 w-5"
															style={{
																color: isCurrentSession
																	? themeGradient.from
																	: isExpired
																		? SEMANTIC_COLORS.error.from
																		: "var(--muted-foreground)",
															}}
														/>
													</div>
													<div className="min-w-0 flex-1">
														<div className="flex flex-wrap items-center gap-2">
															<p className="text-sm font-medium text-foreground truncate">
																{getDeviceLabel(session)}
															</p>
															{isCurrentSession && (
																<span
																	className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium shrink-0"
																	style={{
																		background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
																		color: "white",
																	}}
																>
																	<Check className="h-3 w-3" />
																	Current
																</span>
															)}
															{isExpired && (
																<span
																	className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium shrink-0"
																	style={{
																		backgroundColor: SEMANTIC_COLORS.error.bg,
																		color: SEMANTIC_COLORS.error.text,
																		border: `1px solid ${SEMANTIC_COLORS.error.border}`,
																	}}
																>
																	<AlertCircle className="h-3 w-3" />
																	Expired
																</span>
															)}
														</div>
														{/* IP Address */}
														{session.ipAddress && (
															<p className="mt-1 text-xs text-muted-foreground flex items-center gap-1.5">
																<Wifi className="h-3 w-3" />
																IP: {session.ipAddress}
															</p>
														)}
														{/* Time info */}
														<div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
															<span className="flex items-center gap-1">
																<Clock className="h-3 w-3" />
																Created: {formatDate(session.createdAt)}
															</span>
															<span>Last active: {getRelativeTime(session.lastAccessedAt)}</span>
														</div>
													</div>
												</div>

												{/* Right: Expiry and actions */}
												<div className="flex flex-col items-end gap-2 shrink-0">
													<p
														className={cn(
															"text-sm font-medium",
															isExpired ? "text-destructive" : "text-muted-foreground"
														)}
													>
														{getTimeRemaining(session.expiresAt)}
													</p>
													{/* Revoke button - only show for non-current sessions */}
													{!isCurrentSession && (
														<Button
															size="sm"
															onClick={() => handleRevoke(session.id)}
															disabled={revokingId === session.id}
															className="gap-1.5"
															style={{
																background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}, ${SEMANTIC_COLORS.error.to})`,
																boxShadow: `0 4px 12px -4px ${SEMANTIC_COLORS.error.glow}`,
															}}
														>
															{revokingId === session.id ? (
																<>
																	<Loader2 className="h-3.5 w-3.5 animate-spin" />
																	Revoking...
																</>
															) : (
																"Revoke"
															)}
														</Button>
													)}
												</div>
											</div>
										</div>
									);
								})}
							</div>
						) : (
							<PremiumEmptyState
								icon={Monitor}
								title="No active sessions found"
								description="Unable to retrieve session information"
							/>
						)}
					</div>
				</GlassmorphicCard>

				{/* Info Box */}
				<GlassmorphicCard padding="md">
					<div className="flex gap-3">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Info className="h-5 w-5" style={{ color: themeGradient.from }} />
						</div>
						<div className="text-sm">
							<p className="font-semibold text-foreground">Session Security</p>
							<p className="mt-1 text-muted-foreground">
								If you see sessions you don&apos;t recognize, revoke them immediately and consider
								changing your password. Each session shows the browser, operating system, and IP
								address used at login time.
							</p>
						</div>
					</div>
				</GlassmorphicCard>
			</div>
		</PremiumSection>
	);
};
