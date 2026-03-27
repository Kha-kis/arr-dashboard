"use client";

import type { SeerrUser } from "@arr/shared";
import { ExternalLink, Film, Loader2, Tv, User } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui";
import { useSeerrUserQuota } from "../../../hooks/api/useSeerr";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

// ============================================================================
// Types
// ============================================================================

interface RequesterProfilePopoverProps {
	/** The Seerr user object from the request */
	seerrUser: SeerrUser;
	/** Pre-anonymized display name (parent handles incognito) */
	displayName: string;
	/** Instance ID for quota fetching */
	instanceId: string;
	/** Whether incognito mode is active (hides avatar) */
	isIncognito: boolean;
	/** The trigger element (typically the requester name chip) */
	children: React.ReactNode;
}

// ============================================================================
// Quota bar
// ============================================================================

function QuotaBar({
	label,
	icon: Icon,
	used,
	limit,
	restricted,
}: {
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	used: number;
	limit: number;
	restricted: boolean;
}) {
	if (!restricted) return null;

	const remaining = Math.max(0, limit - used);
	const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
	const isExhausted = remaining === 0;
	const barColor = isExhausted ? SEMANTIC_COLORS.error.from : SEMANTIC_COLORS.success.from;

	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between text-[11px]">
				<span className="flex items-center gap-1 text-muted-foreground">
					<Icon className="h-3 w-3" />
					{label}
				</span>
				<span
					className="font-medium"
					style={{ color: isExhausted ? SEMANTIC_COLORS.error.text : undefined }}
				>
					{used}/{limit}
				</span>
			</div>
			<div className="h-1.5 w-full rounded-full bg-muted/30 overflow-hidden">
				<div
					className="h-full rounded-full transition-all duration-300"
					style={{ width: `${pct}%`, backgroundColor: barColor }}
				/>
			</div>
		</div>
	);
}

// ============================================================================
// Component
// ============================================================================

export const RequesterProfilePopover = ({
	seerrUser,
	displayName,
	instanceId,
	isIncognito,
	children,
}: RequesterProfilePopoverProps) => {
	const [isOpen, setIsOpen] = useState(false);

	// Fetch quota only when popover is open
	const { data: quota, isLoading: quotaLoading, isError: quotaError } = useSeerrUserQuota(
		isOpen ? instanceId : "",
		seerrUser.id,
	);

	const hasMovieQuota = quota?.movie.restricted;
	const hasTvQuota = quota?.tv.restricted;
	const hasAnyQuota = hasMovieQuota || hasTvQuota;

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent
				className="w-64 p-0 border-border/50 bg-card/95 backdrop-blur-xl"
				align="start"
				sideOffset={6}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex items-center gap-3 p-3 border-b border-border/30">
					{seerrUser.avatar && !isIncognito ? (
						/* eslint-disable-next-line @next/next/no-img-element */
						<img
							src={seerrUser.avatar}
							alt={displayName}
							className="h-8 w-8 rounded-full ring-1 ring-border/50"
						/>
					) : (
						<span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted/30 ring-1 ring-border/50">
							<User className="h-4 w-4 text-muted-foreground" />
						</span>
					)}
					<div className="min-w-0 flex-1">
						<p className="text-sm font-semibold text-foreground truncate">{displayName}</p>
						<p className="text-[11px] text-muted-foreground">
							{seerrUser.requestCount} request{seerrUser.requestCount !== 1 ? "s" : ""}
						</p>
					</div>
				</div>

				{/* Quota section */}
				<div className="p-3 space-y-2.5">
					{quotaLoading && (
						<div className="flex items-center justify-center py-1">
							<Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
						</div>
					)}
					{quotaError && (
						<p className="text-[11px] text-destructive/70 text-center py-1">Could not load quota</p>
					)}
					{quota && hasAnyQuota && (
						<>
							{hasMovieQuota && (
								<QuotaBar
									label="Movie Quota"
									icon={Film}
									used={quota.movie.used}
									limit={quota.movie.limit}
									restricted={quota.movie.restricted}
								/>
							)}
							{hasTvQuota && (
								<QuotaBar
									label="TV Quota"
									icon={Tv}
									used={quota.tv.used}
									limit={quota.tv.limit}
									restricted={quota.tv.restricted}
								/>
							)}
						</>
					)}
					{quota && !hasAnyQuota && (
						<p className="text-[11px] text-muted-foreground/60 text-center">No quota restrictions</p>
					)}

					{/* Deep-link action */}
					<Link
						href={`/requests?user=${seerrUser.id}`}
						className="flex items-center justify-center gap-1.5 w-full rounded-lg border border-border/30 bg-muted/10 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors"
						onClick={() => setIsOpen(false)}
					>
						<ExternalLink className="h-3 w-3" />
						View all requests
					</Link>
				</div>
			</PopoverContent>
		</Popover>
	);
};
