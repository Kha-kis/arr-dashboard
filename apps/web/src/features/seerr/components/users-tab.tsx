"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import { AlertCircle, Users, Settings, Loader2 } from "lucide-react";
import type { SeerrUser } from "@arr/shared";
import {
	FilterSelect,
	GlassmorphicCard,
	PremiumEmptyState,
	PremiumProgress,
	PremiumSkeleton,
} from "../../../components/layout";
import { Button } from "../../../components/ui";
import { useSeerrUsers, useSeerrUserQuota } from "../../../hooks/api/useSeerr";
import { UserSettingsDialog } from "./user-settings-dialog";

type UserSort = "displayname" | "created" | "updated" | "requests";

const SORT_OPTIONS: { value: UserSort; label: string }[] = [
	{ value: "displayname", label: "Display Name" },
	{ value: "created", label: "Newest" },
	{ value: "updated", label: "Last Updated" },
	{ value: "requests", label: "Most Requests" },
];

function getUserTypeBadge(userType: number): { label: string; className: string } | null {
	switch (userType) {
		case 1:
			return { label: "Local", className: "bg-sky-500/10 text-sky-400 border-sky-500/20" };
		case 2:
			return { label: "Plex", className: "bg-amber-500/10 text-amber-400 border-amber-500/20" };
		case 3:
			return { label: "Jellyfin", className: "bg-purple-500/10 text-purple-400 border-purple-500/20" };
		default:
			return null;
	}
}

interface UsersTabProps {
	instanceId: string;
}

const PAGE_SIZE = 50;

export const UsersTab = ({ instanceId }: UsersTabProps) => {
	const [sort, setSort] = useState<UserSort>("displayname");
	const [take, setTake] = useState(PAGE_SIZE);
	const { data, isLoading, isFetching, isError } = useSeerrUsers({ instanceId, take, sort });
	const [managingUser, setManagingUser] = useState<SeerrUser | null>(null);
	const totalResults = data?.pageInfo.results ?? 0;
	const hasMore = (data?.results.length ?? 0) < totalResults;
	const handleLoadMore = useCallback(() => setTake((prev) => prev + PAGE_SIZE), []);

	// Reset pagination when sort changes
	const prevSortRef = useRef(sort);
	useEffect(() => {
		if (prevSortRef.current !== sort) {
			setTake(PAGE_SIZE);
			prevSortRef.current = sort;
		}
	}, [sort]);

	if (isLoading) {
		return (
			<div className="space-y-3">
				{Array.from({ length: 3 }).map((_, i) => (
					<PremiumSkeleton key={i} className="h-20 w-full rounded-xl" />
				))}
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={AlertCircle}
				title="Failed to Load Users"
				description="Could not connect to the Seerr instance. Check your configuration in Settings."
			/>
		);
	}

	const users = data?.results ?? [];

	if (users.length === 0) {
		return (
			<PremiumEmptyState
				icon={Users}
				title="No Users"
				description="No users found in this Seerr instance."
			/>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">{totalResults} total users</p>
				<FilterSelect
					value={sort}
					onChange={(v) => setSort(v as UserSort)}
					options={SORT_OPTIONS}
					className="min-w-[140px]"
				/>
			</div>
			{users.map((user, index) => {
				const typeBadge = getUserTypeBadge(user.userType);

				return (
					<div
						key={user.id}
						className="animate-in fade-in slide-in-from-bottom-2 duration-300"
						style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
					>
						<GlassmorphicCard padding="md">
							<div className="flex items-center gap-4">
								{/* Avatar */}
								<div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted/30">
									{user.avatar ? (
										<Image
											src={user.avatar}
											alt={user.displayName}
											width={40}
											height={40}
											className="h-full w-full object-cover"
											unoptimized
										/>
									) : (
										<Users className="h-4 w-4 text-muted-foreground" />
									)}
								</div>

								{/* User info */}
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<h3 className="truncate text-sm font-semibold text-foreground">
											{user.displayName}
										</h3>
										{typeBadge && (
											<span
												className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${typeBadge.className}`}
											>
												{typeBadge.label}
											</span>
										)}
										{user.email && (
											<span className="hidden sm:inline truncate text-xs text-muted-foreground">
												{user.email}
											</span>
										)}
									</div>
									<p className="mt-0.5 text-xs text-muted-foreground">
										{user.requestCount} request{user.requestCount !== 1 ? "s" : ""}
									</p>
								</div>

								{/* Quota bars */}
								<UserQuotaBars instanceId={instanceId} userId={user.id} />

								{/* Manage button */}
								<button
									type="button"
									onClick={() => setManagingUser(user)}
									className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
									title="Manage user quotas"
								>
									<Settings className="h-4 w-4" />
								</button>
							</div>
						</GlassmorphicCard>
					</div>
				);
			})}

			{hasMore && (
				<div className="flex justify-center pt-2">
					<Button
						variant="secondary"
						onClick={handleLoadMore}
						disabled={isFetching}
						className="gap-2 border-border/50 bg-card/50 text-xs"
					>
						{isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
						Load More ({totalResults - users.length} remaining)
					</Button>
				</div>
			)}

			<UserSettingsDialog
				user={managingUser}
				instanceId={instanceId}
				open={managingUser !== null}
				onOpenChange={(open) => {
					if (!open) setManagingUser(null);
				}}
			/>
		</div>
	);
};

/**
 * Inline quota bars — fetches per-user quota on demand.
 */
function UserQuotaBars({ instanceId, userId }: { instanceId: string; userId: number }) {
	const { data: quota } = useSeerrUserQuota(instanceId, userId);

	if (!quota) return null;

	const moviePct =
		quota.movie.restricted && quota.movie.limit > 0
			? Math.round((quota.movie.used / quota.movie.limit) * 100)
			: null;
	const tvPct =
		quota.tv.restricted && quota.tv.limit > 0
			? Math.round((quota.tv.used / quota.tv.limit) * 100)
			: null;

	if (moviePct === null && tvPct === null) return null;

	return (
		<div className="flex shrink-0 flex-col gap-1.5 text-right">
			{moviePct !== null && (
				<div className="flex items-center gap-2">
					<span className="text-[10px] text-muted-foreground">Movie</span>
					<div className="w-20">
						<PremiumProgress value={moviePct} max={100} />
					</div>
					<span className="w-8 text-right text-[10px] text-muted-foreground">
						{quota.movie.used}/{quota.movie.limit}
					</span>
				</div>
			)}
			{tvPct !== null && (
				<div className="flex items-center gap-2">
					<span className="text-[10px] text-muted-foreground">TV</span>
					<div className="w-20">
						<PremiumProgress value={tvPct} max={100} />
					</div>
					<span className="w-8 text-right text-[10px] text-muted-foreground">
						{quota.tv.used}/{quota.tv.limit}
					</span>
				</div>
			)}
		</div>
	);
}
