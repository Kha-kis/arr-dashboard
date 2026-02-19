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
	FileSearch,
	ChevronRight,
} from "lucide-react";
import {
	useTrashSettings,
	useUpdateTrashSettings,
	useTestCustomRepo,
	useResetToOfficialRepo,
	useSupplementaryReport,
} from "../../../hooks/api/useTrashSettings";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { getErrorMessage } from "../../../lib/error-utils";

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
	const [branch, setBranch] = useState("main");
	const [mode, setMode] = useState<"fork" | "supplementary">("fork");
	const [urlError, setUrlError] = useState<string | null>(null);

	// Supplementary report state
	const [reportEnabled, setReportEnabled] = useState(false);
	const [reportServiceType, setReportServiceType] = useState<"RADARR" | "SONARR">("RADARR");
	const reportQuery = useSupplementaryReport(reportServiceType, reportEnabled);

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
			setMode((s.customRepoMode === "supplementary" ? "supplementary" : "fork") as "fork" | "supplementary");
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
			branch: branch.trim() || "main",
		});
	};

	const handleSave = () => {
		const parsed = validateAndParse();
		if (!parsed) return;
		updateMutation.mutate({
			customRepoOwner: parsed.owner,
			customRepoName: parsed.name,
			customRepoBranch: branch.trim() || "main",
			customRepoMode: mode,
		});
	};

	const handleReset = () => {
		resetMutation.mutate(undefined, {
			onSuccess: () => {
				setRepoUrl("");
				setBranch("main");
				setMode("fork");
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

						{/* Current repo badge(s) */}
						{isCustom && settingsData?.settings?.customRepoMode === "supplementary" ? (
							/* Dual-repo display for supplementary mode */
							<div className="mt-4 space-y-2">
								{/* Base: Official TRaSH-Guides */}
								<div className="flex items-center gap-2 flex-wrap">
									<div
										className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium"
										style={{
											backgroundColor: "rgba(255,255,255,0.05)",
											border: `1px solid var(--border)40`,
											color: "var(--foreground)",
										}}
									>
										<GitBranch className="h-3.5 w-3.5" />
										TRaSH-Guides/Guides
									</div>
									<span
										className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
										style={{
											backgroundColor: `${SEMANTIC_COLORS.success.from}15`,
											color: SEMANTIC_COLORS.success.from,
											border: `1px solid ${SEMANTIC_COLORS.success.from}30`,
										}}
									>
										Base
									</span>
								</div>
								{/* Merge indicator */}
								<div className="flex items-center gap-2 pl-4 text-muted-foreground">
									<span className="text-xs font-medium">+</span>
								</div>
								{/* Overlay: Custom repo */}
								<div className="flex items-center gap-2 flex-wrap">
									<div
										className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium"
										style={{
											backgroundColor: `${themeGradient.from}15`,
											border: `1px solid ${themeGradient.from}40`,
											color: themeGradient.from,
										}}
									>
										<GitBranch className="h-3.5 w-3.5" />
										{currentOwner}/{currentName}
									</div>
									<span
										className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
										style={{
											backgroundColor: `${themeGradient.from}15`,
											color: themeGradient.from,
											border: `1px solid ${themeGradient.from}30`,
										}}
									>
										Overlay
									</span>
									<span className="text-xs text-muted-foreground">
										branch: <code className="font-mono">{currentBranch}</code>
									</span>
								</div>
							</div>
						) : (
							/* Single-repo display for fork mode and official */
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
									{isCustom ? "Custom (Fork)" : "Official"}
								</span>
								<span className="text-xs text-muted-foreground">
									branch: <code className="font-mono">{currentBranch}</code>
								</span>
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Override Report — only visible in supplementary mode */}
			{isCustom && settingsData?.settings?.customRepoMode === "supplementary" && (
				<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6 animate-in fade-in duration-300">
					<div className="flex items-start justify-between gap-4">
						<div>
							<h4 className="text-base font-semibold text-foreground flex items-center gap-2">
								<FileSearch className="h-4 w-4" style={{ color: themeGradient.from }} />
								Override Report
							</h4>
							<p className="text-sm text-muted-foreground mt-1">
								Compare your custom repo against official TRaSH Guides to see which entries
								are overrides vs new additions.
							</p>
						</div>
						<div className="flex items-center gap-2 shrink-0">
							{/* Service type toggle */}
							<div className="inline-flex rounded-lg border border-border/50 bg-card/50 p-0.5">
								{(["RADARR", "SONARR"] as const).map((svc) => (
									<button
										key={svc}
										type="button"
										onClick={() => {
											setReportServiceType(svc);
											if (reportEnabled) setReportEnabled(false);
										}}
										className="rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-200"
										style={{
											backgroundColor: reportServiceType === svc ? `${themeGradient.from}15` : "transparent",
											color: reportServiceType === svc ? themeGradient.from : "var(--muted-foreground)",
											border: reportServiceType === svc ? `1px solid ${themeGradient.from}40` : "1px solid transparent",
										}}
									>
										{svc === "RADARR" ? "Radarr" : "Sonarr"}
									</button>
								))}
							</div>
							<button
								type="button"
								onClick={() => {
									if (reportEnabled) {
										void reportQuery.refetch();
									} else {
										setReportEnabled(true);
									}
								}}
								disabled={reportQuery.isFetching}
								className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-all duration-200 disabled:opacity-50"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									boxShadow: `0 2px 8px ${themeGradient.from}30`,
								}}
							>
								{reportQuery.isFetching ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<FileSearch className="h-3.5 w-3.5" />
								)}
								{reportEnabled ? "Refresh" : "Generate Report"}
							</button>
						</div>
					</div>

					{/* Report error */}
					{reportQuery.isError && (
						<div
							className="mt-4 rounded-lg border p-3 text-sm animate-in fade-in duration-200"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								borderColor: SEMANTIC_COLORS.error.border,
							}}
						>
							<div className="flex items-center gap-2">
								<AlertCircle className="h-4 w-4 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
								<p style={{ color: SEMANTIC_COLORS.error.from }}>
									{getErrorMessage(reportQuery.error, "Failed to generate report")}
								</p>
							</div>
						</div>
					)}

					{/* Report results */}
					{reportQuery.data && (
						<div className="mt-4 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
							{(["CUSTOM_FORMATS", "CF_GROUPS", "QUALITY_PROFILES"] as const).map((configType) => {
								const entry = reportQuery.data.configTypes[configType];
								if (!entry) return null;
								const label = configType === "CUSTOM_FORMATS"
									? "Custom Formats"
									: configType === "CF_GROUPS"
										? "CF Groups"
										: "Quality Profiles";
								const hasItems = entry.overrides.length > 0 || entry.additions.length > 0;

								return (
									<div
										key={configType}
										className="rounded-lg border border-border/40 bg-card/20 p-3"
									>
										<div className="flex items-center justify-between">
											<span className="text-sm font-medium text-foreground">{label}</span>
											<div className="flex items-center gap-3 text-xs text-muted-foreground">
												<span>Official: {entry.officialCount}</span>
												<span>Custom: {entry.customCount}</span>
											</div>
										</div>
										<div className="flex items-center gap-4 mt-1.5 text-xs">
											<span style={{ color: themeGradient.from }}>
												{entry.overrides.length} override{entry.overrides.length !== 1 ? "s" : ""}
											</span>
											<span style={{ color: SEMANTIC_COLORS.success.from }}>
												{entry.additions.length} addition{entry.additions.length !== 1 ? "s" : ""}
											</span>
										</div>

										{hasItems && (
											<div className="mt-2 space-y-1.5">
												{entry.overrides.length > 0 && (
													<details className="group">
														<summary className="cursor-pointer text-xs font-medium flex items-center gap-1" style={{ color: themeGradient.from }}>
															<ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
															Overrides ({entry.overrides.length})
														</summary>
														<ul className="mt-1 ml-4 space-y-0.5 text-xs text-muted-foreground">
															{entry.overrides.map((item) => (
																<li key={item.trash_id} className="flex items-center gap-1.5">
																	<span className="h-1 w-1 rounded-full shrink-0" style={{ backgroundColor: themeGradient.from }} />
																	{item.name}
																	<code className="text-[10px] opacity-60 font-mono">{item.trash_id.slice(0, 8)}</code>
																</li>
															))}
														</ul>
													</details>
												)}
												{entry.additions.length > 0 && (
													<details className="group">
														<summary className="cursor-pointer text-xs font-medium flex items-center gap-1" style={{ color: SEMANTIC_COLORS.success.from }}>
															<ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
															Additions ({entry.additions.length})
														</summary>
														<ul className="mt-1 ml-4 space-y-0.5 text-xs text-muted-foreground">
															{entry.additions.map((item) => (
																<li key={item.trash_id} className="flex items-center gap-1.5">
																	<span className="h-1 w-1 rounded-full shrink-0" style={{ backgroundColor: SEMANTIC_COLORS.success.from }} />
																	{item.name}
																	<code className="text-[10px] opacity-60 font-mono">{item.trash_id.slice(0, 8)}</code>
																</li>
															))}
														</ul>
													</details>
												)}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}

			{/* Configure Custom Repository Form */}
			<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6">
				<h4 className="text-base font-semibold text-foreground mb-1">Configure Custom Repository</h4>
				<p className="text-sm text-muted-foreground mb-5">
					Paste the GitHub URL of a TRaSH Guides fork to use custom formats and configurations
					not available in the official repo.
				</p>

				<div className="space-y-4">
					{/* Repository Mode */}
					<div>
						<label className="block text-sm font-medium text-foreground mb-1.5">
							Repository Mode
						</label>
						<div className="inline-flex rounded-lg border border-border/50 bg-card/50 p-1">
							{([
								{
									value: "fork" as const,
									label: "Full Fork",
									desc: "Your repo replaces the official guides entirely",
								},
								{
									value: "supplementary" as const,
									label: "Supplementary",
									desc: "Merged with official guides (custom overrides matching entries)",
								},
							]).map((option) => (
								<button
									key={option.value}
									type="button"
									onClick={() => setMode(option.value)}
									className="relative rounded-md px-4 py-2 text-sm font-medium transition-all duration-200"
									style={{
										backgroundColor: mode === option.value ? `${themeGradient.from}15` : "transparent",
										color: mode === option.value ? themeGradient.from : "var(--muted-foreground)",
										border: mode === option.value ? `1px solid ${themeGradient.from}40` : "1px solid transparent",
									}}
								>
									{option.label}
								</button>
							))}
						</div>
						<p className="mt-1.5 text-xs text-muted-foreground">
							{mode === "fork"
								? "Your fork replaces all official data. Best for full forks that include all official CFs plus your additions."
								: "Official TRaSH Guides data is fetched first, then your repo's configs are merged on top. Matching entries (by trash_id) are overridden by your version."}
						</p>
					</div>

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
							placeholder="main"
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
										{testMutation.data.suggestedBranch && (
											<button
												type="button"
												onClick={() => {
													setBranch(testMutation.data!.suggestedBranch!);
													testMutation.reset();
												}}
												className="mt-1.5 text-xs font-medium transition-colors hover:opacity-80"
												style={{ color: themeGradient.from }}
											>
												Use &ldquo;{testMutation.data.suggestedBranch}&rdquo; branch instead?
											</button>
										)}
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
								{getErrorMessage(testMutation.error, "Failed to test repository")}
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
							? "Settings saved — cache is repopulating from the new repository (this may take up to a minute)."
							: "Settings saved."}
					</div>
				)}

				{updateMutation.isError && (
					<div
						className="mt-3 flex items-center gap-2 text-sm animate-in fade-in duration-200"
						style={{ color: SEMANTIC_COLORS.error.from }}
					>
						<AlertCircle className="h-4 w-4" />
						{getErrorMessage(updateMutation.error, "Failed to save settings")}
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
									Cache is repopulating in the background (this may take up to a minute).
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
							{getErrorMessage(resetMutation.error, "Failed to reset repository")}
						</div>
					)}
				</div>
			)}
		</div>
	);
};
