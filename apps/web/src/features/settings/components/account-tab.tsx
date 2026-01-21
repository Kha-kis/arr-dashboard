"use client";

import { User, Key, Calendar, Check, AlertCircle, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	PremiumSection,
	GlassmorphicCard,
} from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

/**
 * Account form state
 */
export type AccountFormState = {
	username: string;
	tmdbApiKey: string;
};

/**
 * Props for the AccountTab component
 */
interface AccountTabProps {
	/** Current user data */
	currentUser?: {
		username: string;
		createdAt: string;
		hasTmdbApiKey?: boolean;
	} | null;
	/** Account form state */
	accountForm: AccountFormState;
	/** Handler for account form changes */
	onAccountFormChange: (updater: (prev: AccountFormState) => AccountFormState) => void;
	/** Handler for account form submission */
	onAccountUpdate: (event: React.FormEvent<HTMLFormElement>) => void;
	/** Whether account update is pending */
	isUpdating: boolean;
	/** Update result */
	updateResult?: {
		success: boolean;
		message: string;
	} | null;
}

/**
 * Premium Account Tab
 *
 * Account settings with:
 * - Glassmorphic form sections
 * - Theme-aware input focus states
 * - Premium result feedback
 */
export const AccountTab = ({
	currentUser,
	accountForm,
	onAccountFormChange,
	onAccountUpdate,
	isUpdating,
	updateResult,
}: AccountTabProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
			{/* Main form section */}
			<PremiumSection
				title="Account Information"
				description="Update your username and configure integrations"
				icon={User}
			>
				<form className="space-y-6" onSubmit={onAccountUpdate}>
					{/* Username field */}
					<div className="space-y-2">
						<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Username
						</label>
						<Input
							value={accountForm.username}
							onChange={(event) =>
								onAccountFormChange((prev) => ({
									...prev,
									username: event.target.value,
								}))
							}
							placeholder={currentUser?.username ?? ""}
							className="bg-card/30 border-border/50 focus:border-primary"
							style={{
								["--tw-ring-color" as string]: themeGradient.from,
							}}
						/>
						<p className="text-xs text-muted-foreground">
							Current: <span className="text-foreground">{currentUser?.username}</span>
						</p>
					</div>

					{/* TMDB API section */}
					<div
						className="rounded-xl border border-border/50 p-4 space-y-4"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}05, ${themeGradient.to}05)`,
						}}
					>
						<div className="flex items-center gap-2">
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Key className="h-4 w-4" style={{ color: themeGradient.from }} />
							</div>
							<h3 className="text-sm font-semibold text-foreground">TMDB API Integration</h3>
						</div>

						<div className="space-y-2">
							<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
								TMDB API Read Access Token
							</label>
							<Input
								type="password"
								value={accountForm.tmdbApiKey}
								onChange={(event) =>
									onAccountFormChange((prev) => ({
										...prev,
										tmdbApiKey: event.target.value,
									}))
								}
								placeholder={
									currentUser?.hasTmdbApiKey ? "••••••••••••••••" : "Enter your TMDB API Read Access Token"
								}
								className="bg-card/30 border-border/50"
							/>
							<p className="text-xs text-muted-foreground">
								{currentUser?.hasTmdbApiKey ? (
									<span className="flex items-center gap-1">
										<Check className="h-3 w-3 text-green-500" />
										TMDB token is configured. Enter a new token to update it.
									</span>
								) : (
									<>
										Use the <strong className="text-foreground">API Read Access Token</strong> (not API Key) from{" "}
										<a
											href="https://www.themoviedb.org/settings/api"
											target="_blank"
											rel="noopener noreferrer"
											className="inline-flex items-center gap-1 transition-colors"
											style={{ color: themeGradient.from }}
											onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
											onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
										>
											themoviedb.org/settings/api
											<ExternalLink className="h-3 w-3" />
										</a>
									</>
								)}
							</p>
						</div>
					</div>

					{/* Submit button and result */}
					<div className="space-y-4">
						<Button
							type="submit"
							disabled={isUpdating}
							className="gap-2"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
							}}
						>
							{isUpdating ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Saving...
								</>
							) : (
								"Save changes"
							)}
						</Button>

						{updateResult && (
							<div
								className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm animate-in fade-in slide-in-from-bottom-2"
								style={{
									backgroundColor: updateResult.success ? SEMANTIC_COLORS.success.bg : SEMANTIC_COLORS.error.bg,
									border: `1px solid ${updateResult.success ? SEMANTIC_COLORS.success.border : SEMANTIC_COLORS.error.border}`,
									color: updateResult.success ? SEMANTIC_COLORS.success.text : SEMANTIC_COLORS.error.text,
								}}
							>
								{updateResult.success ? (
									<Check className="h-4 w-4 shrink-0" />
								) : (
									<AlertCircle className="h-4 w-4 shrink-0" />
								)}
								<span>{updateResult.message}</span>
							</div>
						)}
					</div>
				</form>
			</PremiumSection>

			{/* Account details sidebar */}
			<GlassmorphicCard padding="lg">
				<div className="space-y-4">
					<div className="flex items-center gap-2">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<User className="h-5 w-5" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h3 className="font-semibold text-foreground">Account Details</h3>
							<p className="text-xs text-muted-foreground">Your current account information</p>
						</div>
					</div>

					<div className="space-y-4 pt-2">
						<div className="space-y-1">
							<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
								<Calendar className="h-3 w-3" />
								Created
							</p>
							<p className="text-sm text-foreground">
								{currentUser?.createdAt
									? new Date(currentUser.createdAt).toLocaleDateString(undefined, {
											year: "numeric",
											month: "long",
											day: "numeric",
										})
									: "-"}
							</p>
						</div>

						<div className="space-y-1">
							<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
								<Key className="h-3 w-3" />
								TMDB Integration
							</p>
							<div className="flex items-center gap-2">
								{currentUser?.hasTmdbApiKey ? (
									<span
										className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
										style={{
											backgroundColor: SEMANTIC_COLORS.success.bg,
											color: SEMANTIC_COLORS.success.text,
											border: `1px solid ${SEMANTIC_COLORS.success.border}`,
										}}
									>
										<Check className="h-3 w-3" />
										Configured
									</span>
								) : (
									<span className="rounded-full bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
										Not configured
									</span>
								)}
							</div>
						</div>
					</div>
				</div>
			</GlassmorphicCard>
		</div>
	);
};
