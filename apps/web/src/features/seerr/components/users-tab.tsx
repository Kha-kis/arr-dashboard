"use client";

import type { SeerrUser } from "@arr/shared";
import { AlertCircle, Loader2, Settings, Users } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	FilterSelect,
	PremiumEmptyState,
	PremiumProgress,
	PremiumSkeleton,
} from "../../../components/layout";
import { Button } from "../../../components/ui";
import { useSeerrUserQuota, useSeerrUsers } from "../../../hooks/api/useSeerr";
import { getLinuxEmail, getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { UserSettingsDialog } from "./user-settings-dialog";

type UserSort = "displayname" | "created" | "updated" | "requests";

const SORT_OPTIONS: { value: UserSort; label: string }[] = [
	{ value: "displayname", label: "Display Name" },
	{ value: "created", label: "Newest" },
	{ value: "updated", label: "Last Updated" },
	{ value: "requests", label: "Most Requests" },
];

const SEERR_GRADIENT = SERVICE_GRADIENTS.seerr;

function getUserTypeBadge(userType: number): { label: string; color: string } | null {
	switch (userType) {
		case 1:
			return { label: "Local", color: "#38bdf8" }; // sky-400
		case 2:
			return { label: "Plex", color: "#e5a00d" }; // plex gold
		case 3:
			return { label: "Jellyfin", color: "#a78bfa" }; // violet-400
		default:
			return null;
	}
}

interface UsersTabProps {
	instanceId: string;
}

const PAGE_SIZE = 50;

export const UsersTab = ({ instanceId }: UsersTabProps) => {
	const [incognitoMode] = useIncognitoMode();
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
						className="group relative rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-[1px] hover:shadow-lg hover:shadow-black/10 animate-in fade-in slide-in-from-bottom-1 duration-300"
						style={{
							border: `1px solid ${SEERR_GRADIENT.from}10`,
							animationDelay: `${index * 50}ms`,
							animationFillMode: "backwards",
						}}
					>
						{/* Background gradient */}
						<div
							className="absolute inset-0 pointer-events-none"
							style={{
								background: `linear-gradient(135deg, ${SEERR_GRADIENT.from}04, transparent 60%)`,
							}}
						/>

						{/* Hover glow */}
						<div
							className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200"
							style={{
								background: `radial-gradient(ellipse at top left, ${SEERR_GRADIENT.from}06, transparent 50%)`,
							}}
						/>

						{/* Accent bar */}
						<div
							className="absolute left-0 top-0 bottom-0 w-[3px]"
							style={{
								background: `linear-gradient(180deg, ${SEERR_GRADIENT.from}, ${SEERR_GRADIENT.to}70)`,
							}}
						/>

						<div className="relative flex items-center gap-4 py-3.5 pl-5 pr-4">
							{/* Avatar */}
							<div
								className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-white/[0.06]"
								style={{
									boxShadow: `0 2px 8px ${SEERR_GRADIENT.from}10`,
									backgroundColor: user.avatar ? undefined : "rgba(255,255,255,0.04)",
								}}
							>
								{user.avatar && !incognitoMode ? (
									<Image
										src={user.avatar}
										alt={user.displayName}
										width={40}
										height={40}
										className="h-full w-full object-cover"
										unoptimized
									/>
								) : (
									<Users className="h-4 w-4 text-muted-foreground/40" />
								)}
							</div>

							{/* User info */}
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<h3 className="truncate text-sm font-semibold text-foreground">
										{incognitoMode ? getLinuxUsername(user.displayName) : user.displayName}
									</h3>
									{typeBadge && (
										<span
											className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0"
											style={{
												backgroundColor: `${typeBadge.color}12`,
												color: typeBadge.color,
												border: `1px solid ${typeBadge.color}18`,
											}}
										>
											{typeBadge.label}
										</span>
									)}
									{user.email && (
										<span className="hidden sm:inline truncate text-[11px] text-muted-foreground/40">
											{incognitoMode ? getLinuxEmail(user.email) : user.email}
										</span>
									)}
								</div>
								<p className="mt-0.5 text-[11px] text-muted-foreground/50">
									{user.requestCount} request{user.requestCount !== 1 ? "s" : ""}
								</p>
							</div>

							{/* Quota bars */}
							<UserQuotaBars instanceId={instanceId} userId={user.id} />

							{/* Manage button */}
							<button
								type="button"
								onClick={() => setManagingUser(user)}
								className="shrink-0 rounded-lg p-1.5 text-muted-foreground/40 transition-all hover:bg-white/[0.06] hover:text-foreground opacity-0 group-hover:opacity-100"
								title="Manage user quotas"
							>
								<Settings className="h-4 w-4" />
							</button>
						</div>
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
