"use client";

import { useState } from "react";
import { AlertCircle, Users, Settings } from "lucide-react";
import type { SeerrUser } from "@arr/shared";
import {
	GlassmorphicCard,
	PremiumEmptyState,
	PremiumProgress,
	PremiumSkeleton,
} from "../../../components/layout";
import { useSeerrUsers, useSeerrUserQuota } from "../../../hooks/api/useSeerr";
import { UserSettingsDialog } from "./user-settings-dialog";

interface UsersTabProps {
	instanceId: string;
}

export const UsersTab = ({ instanceId }: UsersTabProps) => {
	const { data, isLoading, isError } = useSeerrUsers({ instanceId, take: 50 });
	const [managingUser, setManagingUser] = useState<SeerrUser | null>(null);

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
			{users.map((user, index) => (
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
									<img
										src={user.avatar}
										alt={user.displayName}
										className="h-full w-full object-cover"
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
									{user.email && (
										<span className="truncate text-xs text-muted-foreground">{user.email}</span>
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
			))}

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
