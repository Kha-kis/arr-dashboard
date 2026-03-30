"use client";

import type { SeerrRequest } from "@arr/shared";
import {
	Check,
	CheckCircle,
	ChevronRight,
	Clock,
	Film,
	Inbox,
	Loader2,
	Tv,
	User,
	X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	useApproveSeerrRequest,
	useSeerrRequestCount,
	useSeerrRequests,
} from "../../../hooks/api/useSeerr";
import { getLinuxIsoName, getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { RequestStatusTimeline } from "../../seerr/components/request-status-timeline";
import { formatRelativeTime, getPosterUrl } from "../../seerr/lib/seerr-utils";

interface SeerrRequestsWidgetProps {
	instanceId: string;
	animationDelay?: number;
}

const seerrGradient = SERVICE_GRADIENTS.seerr;

export const SeerrRequestsWidget = ({
	instanceId,
	animationDelay = 0,
}: SeerrRequestsWidgetProps) => {
	const { data: counts, isError } = useSeerrRequestCount(instanceId);
	const { data: pendingData } = useSeerrRequests({
		instanceId,
		filter: "pending",
		take: 1,
		sort: "added",
	});
	const pendingRequest = pendingData?.results?.[0];

	if (!counts && !isError) return null;

	if (isError) {
		return (
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
			>
				<Link href="/requests" className="block">
					<div className="overflow-hidden rounded-xl border border-border/30 bg-muted/10 group transition-all hover:border-border/80">
						<div
							className="h-0.5 w-full rounded-t-xl"
							style={{
								background: `linear-gradient(90deg, ${seerrGradient.from}, ${seerrGradient.to})`,
							}}
						/>
						<div className="flex items-center gap-3 p-4">
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{
									background: `linear-gradient(135deg, ${seerrGradient.from}20, ${seerrGradient.to}20)`,
									border: `1px solid ${seerrGradient.from}30`,
								}}
							>
								<Inbox className="h-4 w-4" style={{ color: seerrGradient.from }} />
							</div>
							<div>
								<h3 className="text-sm font-semibold text-foreground">Seerr Requests</h3>
								<p className="text-xs text-muted-foreground">Could not load request counts</p>
							</div>
						</div>
					</div>
				</Link>
			</div>
		);
	}

	const statusStats = [
		{ icon: Clock, label: "Pending", value: counts.pending, color: SEMANTIC_COLORS.warning.text },
		{ icon: Loader2, label: "Processing", value: counts.processing, color: "#facc15" },
		{ icon: Check, label: "Approved", value: counts.approved, color: SEMANTIC_COLORS.success.text },
		{ icon: X, label: "Declined", value: counts.declined, color: SEMANTIC_COLORS.error.text },
	];

	const mediaStats = [
		{ icon: Film, label: "Movies", value: counts.movie },
		{ icon: Tv, label: "TV", value: counts.tv },
		{
			icon: CheckCircle,
			label: "Available",
			value: counts.available,
			color: SEMANTIC_COLORS.success.text,
		},
	];

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<Link href="/requests" className="block">
				<div className="overflow-hidden rounded-xl border border-border/30 bg-muted/10 group transition-all hover:border-border/80">
					{/* Accent line */}
					<div
						className="h-0.5 w-full rounded-t-xl"
						style={{
							background: `linear-gradient(90deg, ${seerrGradient.from}, ${seerrGradient.to})`,
						}}
					/>

					<div className="p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${seerrGradient.from}20, ${seerrGradient.to}20)`,
										border: `1px solid ${seerrGradient.from}30`,
									}}
								>
									<Inbox className="h-4 w-4" style={{ color: seerrGradient.from }} />
								</div>
								<div>
									<h3 className="text-sm font-semibold text-foreground">Seerr Requests</h3>
									<p className="text-xs text-muted-foreground">
										{counts.total} total request{counts.total !== 1 ? "s" : ""}
									</p>
								</div>
							</div>
							<ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
						</div>

						{/* Pending request quick-approve */}
						{pendingRequest && counts.pending > 0 && (
							<PendingRequestCard
								request={pendingRequest}
								instanceId={instanceId}
								pendingCount={counts.pending}
							/>
						)}

						{/* Status stats row */}
						<div className="mt-3 flex items-center gap-4">
							{statusStats.map((stat) => (
								<div key={stat.label} className="flex items-center gap-1.5">
									<stat.icon className="h-3 w-3" style={{ color: stat.color }} />
									<span className="text-xs font-medium text-foreground">{stat.value}</span>
									<span className="text-[10px] text-muted-foreground">{stat.label}</span>
								</div>
							))}
						</div>

						{/* Media type breakdown row */}
						<div className="mt-2 flex items-center gap-4">
							{mediaStats.map((stat) => (
								<div key={stat.label} className="flex items-center gap-1.5">
									<stat.icon
										className="h-3 w-3"
										style={{ color: stat.color ?? "var(--muted-foreground)" }}
									/>
									<span className="text-xs font-medium text-foreground">{stat.value}</span>
									<span className="text-[10px] text-muted-foreground">{stat.label}</span>
								</div>
							))}
						</div>
					</div>
				</div>
			</Link>
		</div>
	);
};

// ============================================================================
// Pending Request Card (inline in widget)
// ============================================================================

function PendingRequestCard({
	request,
	instanceId,
	pendingCount,
}: {
	request: SeerrRequest;
	instanceId: string;
	pendingCount: number;
}) {
	const [incognitoMode] = useIncognitoMode();
	const approveMutation = useApproveSeerrRequest();
	const [isApproving, setIsApproving] = useState(false);

	const posterUrl = getPosterUrl(request.media.posterPath);
	const title = incognitoMode
		? getLinuxIsoName(request.media.title ?? String(request.media.tmdbId))
		: (request.media.title ?? `Request #${request.id}`);
	const requester = incognitoMode
		? getLinuxUsername(request.requestedBy?.displayName ?? "Unknown")
		: (request.requestedBy?.displayName ?? "Unknown");

	const handleApprove = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsApproving(true);
			approveMutation.mutate(
				{ instanceId, requestId: request.id },
				{
					onSuccess: () => {
						toast.success("Request approved");
						setIsApproving(false);
					},
					onError: () => {
						toast.error("Failed to approve request");
						setIsApproving(false);
					},
				},
			);
		},
		[approveMutation, instanceId, request.id],
	);

	return (
		<div className="mt-3 rounded-lg border border-border/20 bg-card/20 p-3">
			<div className="flex items-start gap-3">
				{/* Poster */}
				<div
					className="shrink-0 w-[36px] h-[52px] rounded overflow-hidden ring-1 ring-white/[0.06] flex items-center justify-center"
					style={{
						backgroundColor: posterUrl ? undefined : "rgba(255,255,255,0.04)",
					}}
				>
					{posterUrl && !incognitoMode ? (
						<Image
							src={posterUrl}
							alt=""
							width={36}
							height={52}
							className="object-cover w-full h-full"
							unoptimized
						/>
					) : (
						<Film className="h-4 w-4 text-muted-foreground/40" />
					)}
				</div>

				{/* Info */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-1.5">
						<span className="text-xs font-medium text-foreground truncate">{title}</span>
						<span
							className="shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider"
							style={{
								background: `${seerrGradient.from}15`,
								color: seerrGradient.from,
							}}
						>
							{request.type === "movie" ? "Movie" : "TV"}
						</span>
					</div>

					<div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
						<User className="h-2.5 w-2.5" />
						<span className="truncate">{requester}</span>
						<span className="mx-0.5">·</span>
						<span>{formatRelativeTime(request.createdAt)}</span>
					</div>

					{/* Compact timeline */}
					<div className="mt-1.5">
						<RequestStatusTimeline request={request} variant="compact" />
					</div>
				</div>

				{/* Approve button */}
				<button
					type="button"
					onClick={handleApprove}
					disabled={isApproving}
					aria-label={`Approve request for ${title}`}
					className="shrink-0 flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-white transition-colors disabled:opacity-50"
					style={{
						background: `linear-gradient(135deg, ${seerrGradient.from}, ${seerrGradient.to})`,
					}}
				>
					{isApproving ? (
						<Loader2 className="h-3 w-3 animate-spin" />
					) : (
						<Check className="h-3 w-3" />
					)}
					<span className="hidden sm:inline">Approve</span>
				</button>
			</div>

			{/* "View all N pending" link */}
			{pendingCount > 1 && (
				<p className="mt-2 text-[10px] text-muted-foreground">+{pendingCount - 1} more pending</p>
			)}
		</div>
	);
}
