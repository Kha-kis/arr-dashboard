"use client";

import { useState, useEffect, useCallback } from "react";
import {
	GitBranch,
	CheckCircle2,
	XCircle,
	Loader2,
	RotateCcw,
	Save,
	FlaskConical,
	Globe,
	AlertCircle,
	Link,
} from "lucide-react";
import {
	useTrashSettings,
	useUpdateTrashSettings,
	useTestCustomRepo,
	useResetToOfficialRepo,
} from "../../../hooks/api/useTrashSettings";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

// ============================================================================
// URL Parsing Utilities
// ============================================================================

/**
 * Parse a GitHub URL into owner and name components.
 * Supports formats:
 *   - https://github.com/owner/name
 *   - https://github.com/owner/name.git
 *   - github.com/owner/name
 *   - git@github.com:owner/name.git
 */
function parseGitHubUrl(url: string): { owner: string; name: string } | null {
	const trimmed = url.trim();
	if (!trimmed) return null;

	// HTTPS format: https://github.com/owner/name or github.com/owner/name
	const httpsMatch = trimmed.match(
		/^(?:https?:\/\/)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/,
	);
	if (httpsMatch?.[1] && httpsMatch[2]) {
		return { owner: httpsMatch[1], name: httpsMatch[2] };
	}

	// SSH format: git@github.com:owner/name.git
	const sshMatch = trimmed.match(
		/^git@github\.com:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/,
	);
	if (sshMatch?.[1] && sshMatch[2]) {
		return { owner: sshMatch[1], name: sshMatch[2] };
	}

	return null;
}

/**
 * Build a display URL from owner and name.
 */
function buildGitHubUrl(owner: string, name: string): string {
	return `https://github.com/${owner}/${name}`;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Repository Settings Section for TRaSH Guides
 *
 * Allows the user to configure a custom GitHub repository (e.g., a fork)
 * as the upstream source for TRaSH Guides data, or reset to the official repo.
 * Uses a single Git URL input (like Recyclarr) instead of separate fields.
 */
export const RepoSettingsSection = () => {
	const { gradient: themeGradient } = useThemeGradient();

	// API hooks
	const { data: settingsData, isLoading } = useTrashSettings();
	const updateMutation = useUpdateTrashSettings();
	const testMutation = useTestCustomRepo();
	const resetMutation = useResetToOfficialRepo();

	// Form state — URL-based input
	const [repoUrl, setRepoUrl] = useState("");
	const [branch, setBranch] = useState("master");
	const [urlError, setUrlError] = useState<string | null>(null);

	// Seed form from API response
	useEffect(() => {
		if (settingsData?.settings) {
			const s = settingsData.settings;
			if (s.customRepoOwner) {
				setRepoUrl(buildGitHubUrl(s.customRepoOwner, s.customRepoName ?? "Guides"));
			} else {
				setRepoUrl("");
			}
			setBranch(s.customRepoBranch ?? settingsData.defaultRepo?.branch ?? "master");
		}
	}, [settingsData]);

	const isCustom = !!settingsData?.settings?.customRepoOwner;
	const currentOwner = settingsData?.settings?.customRepoOwner ?? settingsData?.defaultRepo?.owner ?? "TRaSH-Guides";
	const currentName = settingsData?.settings?.customRepoName ?? settingsData?.defaultRepo?.name ?? "Guides";
	const currentBranch = settingsData?.settings?.customRepoBranch ?? settingsData?.defaultRepo?.branch ?? "master";

	const validateAndParse = useCallback(() => {
		const parsed = parseGitHubUrl(repoUrl);
		if (!repoUrl.trim()) {
			setUrlError(null);
			return null;
		}
		if (!parsed) {
			setUrlError("Enter a valid GitHub URL (e.g., https://github.com/owner/repo)");
			return null;
		}
		setUrlError(null);
		return parsed;
	}, [repoUrl]);

	const handleUrlChange = (value: string) => {
		setRepoUrl(value);
		setUrlError(null);
		testMutation.reset();
	};

	const handleTest = () => {
		const parsed = validateAndParse();
		if (!parsed) return;
		testMutation.mutate({
			owner: parsed.owner,
			name: parsed.name,
			branch: branch.trim() || "master",
		});
	};

	const handleSave = () => {
		const parsed = validateAndParse();
		if (!parsed) return;
		updateMutation.mutate({
			customRepoOwner: parsed.owner,
			customRepoName: parsed.name,
			customRepoBranch: branch.trim() || "master",
		});
	};

	const handleReset = () => {
		resetMutation.mutate(undefined, {
			onSuccess: () => {
				setRepoUrl("");
				setBranch("master");
				setUrlError(null);
				testMutation.reset();
			},
		});
	};

	// Check if the URL is valid for enabling action buttons
	const parsedUrl = parseGitHubUrl(repoUrl);
	const canSubmit = !!parsedUrl;

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-16">
				<div
					className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
					style={{ borderColor: `${themeGradient.from}40`, borderTopColor: "transparent" }}
				/>
			</div>
		);
	}

	return (
		<div className="space-y-6 animate-in fade-in duration-300">
			{/* Current Repository Display */}
			<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6">
				<div className="flex items-start gap-4">
					<div
						className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: `1px solid ${themeGradient.from}30`,
						}}
					>
						<Globe className="h-6 w-6" style={{ color: themeGradient.from }} />
					</div>
					<div className="flex-1 min-w-0">
						<h3
							className="text-lg font-semibold"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								WebkitBackgroundClip: "text",
								WebkitTextFillColor: "transparent",
							}}
						>
							Repository Source
						</h3>
						<p className="text-muted-foreground mt-1">
							Configure which GitHub repository to use for TRaSH Guides data. Forks maintain the same directory
							structure, so all parsing works automatically.
						</p>

						{/* Current repo badge */}
						<div className="flex items-center gap-3 mt-4 flex-wrap">
							<div
								className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium"
								style={{
									backgroundColor: isCustom ? `${themeGradient.from}15` : "rgba(255,255,255,0.05)",
									border: `1px solid ${isCustom ? themeGradient.from : "var(--border)"}40`,
									color: isCustom ? themeGradient.from : "var(--foreground)",
								}}
							>
								<GitBranch className="h-3.5 w-3.5" />
								{currentOwner}/{currentName}
							</div>
							<span
								className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
								style={{
									backgroundColor: isCustom
										? `${themeGradient.from}15`
										: `${SEMANTIC_COLORS.success.from}15`,
									color: isCustom ? themeGradient.from : SEMANTIC_COLORS.success.from,
									border: `1px solid ${isCustom ? themeGradient.from : SEMANTIC_COLORS.success.from}30`,
								}}
							>
								{isCustom ? "Custom" : "Official"}
							</span>
							<span className="text-xs text-muted-foreground">
								branch: <code className="font-mono">{currentBranch}</code>
							</span>
						</div>
					</div>
				</div>
			</div>

			{/* Configure Custom Repository Form */}
			<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6">
				<h4 className="text-base font-semibold text-foreground mb-1">Configure Custom Repository</h4>
				<p className="text-sm text-muted-foreground mb-5">
					Paste the GitHub URL of a TRaSH Guides fork to use custom formats and configurations
					not available in the official repo.
				</p>

				<div className="space-y-4">
					{/* Git URL */}
					<div>
						<label htmlFor="repo-url" className="block text-sm font-medium text-foreground mb-1.5">
							Git URL
						</label>
						<div className="relative">
							<div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
								<Link className="h-4 w-4 text-muted-foreground/50" />
							</div>
							<input
								id="repo-url"
								type="text"
								value={repoUrl}
								onChange={(e) => handleUrlChange(e.target.value)}
								onBlur={(e) => {
								e.currentTarget.style.borderColor = "";
								e.currentTarget.style.boxShadow = "";
								validateAndParse();
							}}
								placeholder="https://github.com/owner/Guides"
								className="w-full rounded-lg border border-border/50 bg-card/50 pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-hidden transition-all duration-200"
								onFocus={(e) => {
									e.currentTarget.style.borderColor = urlError ? SEMANTIC_COLORS.error.from : themeGradient.from;
									e.currentTarget.style.boxShadow = `0 0 0 2px ${urlError ? `${SEMANTIC_COLORS.error.from}20` : themeGradient.fromLight}`;
								}}
								style={urlError ? { borderColor: SEMANTIC_COLORS.error.from } : undefined}
							/>
						</div>
						{urlError && (
							<p className="mt-1.5 text-xs flex items-center gap-1" style={{ color: SEMANTIC_COLORS.error.from }}>
								<AlertCircle className="h-3 w-3" />
								{urlError}
							</p>
						)}
						{parsedUrl && !urlError && repoUrl.trim() && (
							<p className="mt-1.5 text-xs text-muted-foreground">
								Parsed: <span className="font-mono">{parsedUrl.owner}/{parsedUrl.name}</span>
							</p>
						)}
					</div>

					{/* Branch */}
					<div className="max-w-xs">
						<label htmlFor="repo-branch" className="block text-sm font-medium text-foreground mb-1.5">
							Branch <span className="text-muted-foreground font-normal">(optional)</span>
						</label>
						<input
							id="repo-branch"
							type="text"
							value={branch}
							onChange={(e) => {
								setBranch(e.target.value);
								testMutation.reset();
							}}
							placeholder="master"
							className="w-full rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-hidden transition-all duration-200"
							onFocus={(e) => {
								e.currentTarget.style.borderColor = themeGradient.from;
								e.currentTarget.style.boxShadow = `0 0 0 2px ${themeGradient.fromLight}`;
							}}
							onBlur={(e) => {
								e.currentTarget.style.borderColor = "";
								e.currentTarget.style.boxShadow = "";
							}}
						/>
						<p className="mt-1.5 text-xs text-muted-foreground">
							Defaults to <code className="font-mono">master</code> if left empty.
						</p>
					</div>
				</div>

				{/* Test Result */}
				{testMutation.data && (
					<div
						className="mt-4 rounded-lg border p-3 text-sm animate-in fade-in slide-in-from-top-1 duration-200"
						style={{
							backgroundColor: testMutation.data.valid
								? SEMANTIC_COLORS.success.bg
								: SEMANTIC_COLORS.error.bg,
							borderColor: testMutation.data.valid
								? SEMANTIC_COLORS.success.border
								: SEMANTIC_COLORS.error.border,
						}}
					>
						<div className="flex items-start gap-2">
							{testMutation.data.valid ? (
								<CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" style={{ color: SEMANTIC_COLORS.success.from }} />
							) : (
								<XCircle className="h-4 w-4 mt-0.5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
							)}
							<div>
								{testMutation.data.valid ? (
									<>
										<p className="font-medium" style={{ color: SEMANTIC_COLORS.success.from }}>
											Repository validated
										</p>
										{testMutation.data.structure && (
											<p className="text-muted-foreground mt-0.5">
												Found: {[
													testMutation.data.structure.hasRadarr && "Radarr",
													testMutation.data.structure.hasSonarr && "Sonarr",
												].filter(Boolean).join(", ")} configurations
												{testMutation.data.structure.directoriesFound.length > 0 && (
													<span className="text-xs ml-1">
														({testMutation.data.structure.directoriesFound.length} directories)
													</span>
												)}
											</p>
										)}
									</>
								) : (
									<>
										<p className="font-medium" style={{ color: SEMANTIC_COLORS.error.from }}>
											Validation failed
										</p>
										<p className="text-muted-foreground mt-0.5">
											{testMutation.data.error || "Repository does not have the expected TRaSH Guides structure."}
										</p>
									</>
								)}
							</div>
						</div>
					</div>
				)}

				{testMutation.isError && (
					<div
						className="mt-4 rounded-lg border p-3 text-sm animate-in fade-in slide-in-from-top-1 duration-200"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							borderColor: SEMANTIC_COLORS.error.border,
						}}
					>
						<div className="flex items-center gap-2">
							<AlertCircle className="h-4 w-4 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
							<p style={{ color: SEMANTIC_COLORS.error.from }}>
								{testMutation.error instanceof Error ? testMutation.error.message : "Failed to test repository"}
							</p>
						</div>
					</div>
				)}

				{/* Action Buttons */}
				<div className="flex items-center gap-3 mt-5">
					<button
						type="button"
						onClick={handleTest}
						disabled={!canSubmit || testMutation.isPending}
						className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-4 py-2 text-sm font-medium text-foreground transition-all duration-200 hover:bg-card/80 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{testMutation.isPending ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<FlaskConical className="h-4 w-4" />
						)}
						Test Connection
					</button>

					<button
						type="button"
						onClick={handleSave}
						disabled={!canSubmit || updateMutation.isPending}
						className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 2px 8px ${themeGradient.from}30`,
						}}
					>
						{updateMutation.isPending ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Save className="h-4 w-4" />
						)}
						Save &amp; Refresh Cache
					</button>
				</div>

				{/* Save Success/Error feedback */}
				{updateMutation.isSuccess && (
					<div
						className="mt-3 flex items-center gap-2 text-sm animate-in fade-in duration-200"
						style={{ color: SEMANTIC_COLORS.success.from }}
					>
						<CheckCircle2 className="h-4 w-4" />
						{updateMutation.data.cacheCleared
							? "Settings saved — cache is being populated from the new repository."
							: "Settings saved."}
					</div>
				)}

				{updateMutation.isError && (
					<div
						className="mt-3 flex items-center gap-2 text-sm animate-in fade-in duration-200"
						style={{ color: SEMANTIC_COLORS.error.from }}
					>
						<AlertCircle className="h-4 w-4" />
						{updateMutation.error instanceof Error ? updateMutation.error.message : "Failed to save settings"}
					</div>
				)}
			</div>

			{/* Reset to Official */}
			{isCustom && (
				<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6 animate-in fade-in duration-300">
					<div className="flex items-start justify-between gap-4">
						<div>
							<h4 className="text-base font-semibold text-foreground">Reset to Official Repository</h4>
							<p className="text-sm text-muted-foreground mt-1">
								Switch back to the official <code className="font-mono text-xs bg-muted/30 px-1 py-0.5 rounded">TRaSH-Guides/Guides</code> repository.
								This will clear your custom repo configuration and all cached data.
							</p>
						</div>
						<button
							type="button"
							onClick={handleReset}
							disabled={resetMutation.isPending}
							className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all duration-200 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
							style={{
								borderColor: `${SEMANTIC_COLORS.error.from}40`,
								color: SEMANTIC_COLORS.error.from,
								backgroundColor: `${SEMANTIC_COLORS.error.from}08`,
							}}
						>
							{resetMutation.isPending ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<RotateCcw className="h-4 w-4" />
							)}
							Reset to Official
						</button>
					</div>

					{resetMutation.isSuccess && (
						<div
							className="mt-3 flex items-center gap-2 text-sm animate-in fade-in duration-200"
							style={{ color: SEMANTIC_COLORS.success.from }}
						>
							<CheckCircle2 className="h-4 w-4" />
							Reset complete — using official TRaSH-Guides repository.
							{resetMutation.data.cacheEntriesCleared > 0 && (
								<span className="text-muted-foreground ml-1">
									({resetMutation.data.cacheEntriesCleared} cache entries cleared)
								</span>
							)}
						</div>
					)}

					{resetMutation.isError && (
						<div
							className="mt-3 flex items-center gap-2 text-sm animate-in fade-in duration-200"
							style={{ color: SEMANTIC_COLORS.error.from }}
						>
							<AlertCircle className="h-4 w-4" />
							{resetMutation.error instanceof Error ? resetMutation.error.message : "Failed to reset repository"}
						</div>
					)}
				</div>
			)}
		</div>
	);
};
