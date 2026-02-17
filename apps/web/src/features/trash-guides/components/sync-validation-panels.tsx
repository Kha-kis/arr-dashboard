"use client";

/**
 * Sync Validation Panels
 *
 * Sub-panels for the sync validation modal's result display.
 * Each panel handles a specific validation outcome state.
 */

import {
	AlertCircle,
	CheckCircle2,
	Eye,
	HelpCircle,
	Plug,
	RefreshCw,
	Upload,
	XCircle,
} from "lucide-react";
import { Button } from "../../../components/ui";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import type { ErrorType } from "../lib/sync-validation-utils";

/** Shared retry props used by multiple panels */
interface RetryProps {
	handleRetry: () => void;
	isValidating: boolean;
	retryCount: number;
	maxManualRetries: number;
}

// ============================================================================
// SilentFailurePanel — "valid=false with 0 errors" fallback
// ============================================================================

export const SilentFailurePanel = ({
	handleRetry,
	isValidating,
	retryCount,
	maxManualRetries,
}: RetryProps) => (
	<div
		className="rounded-xl p-4"
		style={{
			backgroundColor: SEMANTIC_COLORS.warning.bg,
			border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
		}}
	>
		<div className="flex items-start gap-3">
			<HelpCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.warning.from }} />
			<div className="flex-1">
				<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.warning.text }}>
					Validation Failed
				</h3>
				<p className="mt-1 text-sm" style={{ color: SEMANTIC_COLORS.warning.text }}>
					Validation could not be completed, but no specific errors were reported.
					This may be a temporary issue.
				</p>
				<div className="mt-3 flex items-center gap-3">
					<Button
						variant="outline"
						size="sm"
						onClick={handleRetry}
						disabled={isValidating}
						className="gap-2 rounded-xl"
					>
						<RefreshCw className={`h-3 w-3 ${isValidating ? "animate-spin" : ""}`} />
						{retryCount > 0
							? `Retry (${retryCount}/${maxManualRetries})`
							: "Retry Validation"}
					</Button>
					<span className="text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>
						Try again or check your instance connectivity
					</span>
				</div>
			</div>
		</div>
	</div>
);

// ============================================================================
// ValidationErrorPanel — errors with contextual action buttons
// ============================================================================

interface ValidationErrorPanelProps extends RetryProps {
	errors: string[];
	errorTypes: Set<ErrorType>;
	themeGradient: { from: string; to: string };
	onCancel: () => void;
	onNavigateToDeploy?: () => void;
	onTestConnection?: () => void;
	onViewChanges?: () => void;
	onSwitchToManualSync?: () => void;
}

export const ValidationErrorPanel = ({
	errors,
	errorTypes,
	themeGradient,
	handleRetry,
	isValidating,
	retryCount,
	maxManualRetries,
	onCancel,
	onNavigateToDeploy,
	onTestConnection,
	onViewChanges,
	onSwitchToManualSync,
}: ValidationErrorPanelProps) => (
	<div
		className="rounded-xl p-4"
		style={{
			backgroundColor: SEMANTIC_COLORS.error.bg,
			border: `1px solid ${SEMANTIC_COLORS.error.border}`,
		}}
	>
		<div className="flex items-start gap-3">
			<XCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
			<div className="flex-1">
				<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
					Validation Failed
				</h3>
				<ul className="mt-2 space-y-1 text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
					{errors.map((error, index) => (
						<li key={index}>• {error}</li>
					))}
				</ul>

				{/* Contextual action buttons */}
				<div className="mt-4 flex flex-wrap gap-2">
					{errorTypes.has("MISSING_MAPPING") && onNavigateToDeploy && (
						<Button
							size="sm"
							onClick={() => {
								onCancel();
								onNavigateToDeploy();
							}}
							className="gap-2 rounded-xl font-medium"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							}}
						>
							<Upload className="h-3 w-3" />
							Deploy Template
						</Button>
					)}

					{errorTypes.has("UNREACHABLE_INSTANCE") && onTestConnection && (
						<Button
							variant="outline"
							size="sm"
							onClick={onTestConnection}
							className="gap-2 rounded-xl"
						>
							<Plug className="h-3 w-3" />
							Test Connection
						</Button>
					)}

					{errorTypes.has("USER_MODIFICATIONS") && (
						<>
							{onSwitchToManualSync && (
								<Button
									size="sm"
									onClick={() => {
										onCancel();
										onSwitchToManualSync();
									}}
									className="gap-2 rounded-xl font-medium"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									}}
								>
									<RefreshCw className="h-3 w-3" />
									Switch to Manual Sync
								</Button>
							)}
							{onViewChanges && (
								<Button
									variant="outline"
									size="sm"
									onClick={onViewChanges}
									className="gap-2 rounded-xl"
								>
									<Eye className="h-3 w-3" />
									View Changes
								</Button>
							)}
						</>
					)}

					<Button
						variant="outline"
						size="sm"
						onClick={handleRetry}
						disabled={isValidating}
						className="gap-2 rounded-xl"
					>
						<RefreshCw className={`h-3 w-3 ${isValidating ? "animate-spin" : ""}`} />
						{retryCount > 0
							? `Retry (${retryCount}/${maxManualRetries})`
							: "Retry Validation"}
					</Button>
				</div>

				{/* Helpful hints */}
				{errorTypes.has("MISSING_MAPPING") && (
					<p className="mt-3 text-xs opacity-80" style={{ color: SEMANTIC_COLORS.error.text }}>
						This template needs to be deployed to the instance before syncing.
					</p>
				)}
				{errorTypes.has("USER_MODIFICATIONS") && (
					<p className="mt-3 text-xs opacity-80" style={{ color: SEMANTIC_COLORS.error.text }}>
						Auto-sync is disabled for templates with local modifications to protect your changes.
					</p>
				)}
				{errorTypes.has("UNREACHABLE_INSTANCE") && (
					<p className="mt-3 text-xs opacity-80" style={{ color: SEMANTIC_COLORS.error.text }}>
						Check that the instance is running and the URL/API key are correct.
					</p>
				)}
			</div>
		</div>
	</div>
);

// ============================================================================
// ValidationWarningsPanel — actual warnings display
// ============================================================================

export const ValidationWarningsPanel = ({ warnings }: { warnings: string[] }) => (
	<div
		className="rounded-xl p-4"
		style={{
			backgroundColor: SEMANTIC_COLORS.warning.bg,
			border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
		}}
	>
		<div className="flex items-start gap-3">
			<AlertCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.warning.from }} />
			<div className="flex-1">
				<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.warning.text }}>
					Warnings
				</h3>
				<ul className="mt-2 space-y-1 text-sm" style={{ color: SEMANTIC_COLORS.warning.text }}>
					{warnings.map((warning, index) => (
						<li key={index}>• {warning}</li>
					))}
				</ul>
			</div>
		</div>
	</div>
);

// ============================================================================
// ValidationSuccessPanel — green checkmark "Ready to sync"
// ============================================================================

export const ValidationSuccessPanel = () => (
	<div
		className="rounded-xl p-4"
		style={{
			backgroundColor: SEMANTIC_COLORS.success.bg,
			border: `1px solid ${SEMANTIC_COLORS.success.border}`,
		}}
	>
		<div className="flex items-center gap-3">
			<CheckCircle2 className="h-5 w-5" style={{ color: SEMANTIC_COLORS.success.from }} />
			<div>
				<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.success.text }}>
					Validation Passed
				</h3>
				<p className="mt-0.5 text-sm" style={{ color: SEMANTIC_COLORS.success.text }}>
					Ready to sync
				</p>
			</div>
		</div>
	</div>
);

// ============================================================================
// MutationErrorPanel — network/API error with retry
// ============================================================================

interface MutationErrorPanelProps extends RetryProps {
	error: Error;
}

export const MutationErrorPanel = ({
	error,
	handleRetry,
	isValidating,
	retryCount,
	maxManualRetries,
}: MutationErrorPanelProps) => (
	<div
		className="rounded-xl p-4"
		style={{
			backgroundColor: SEMANTIC_COLORS.error.bg,
			border: `1px solid ${SEMANTIC_COLORS.error.border}`,
		}}
	>
		<div className="flex items-start gap-3">
			<XCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
			<div className="flex-1">
				<h3 className="font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
					Validation Error
				</h3>
				<p className="mt-1 text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
					{error.message || "An unknown error occurred while validating the sync request."}
				</p>
				<div className="mt-3 flex items-center gap-3">
					<Button
						variant="outline"
						size="sm"
						onClick={handleRetry}
						disabled={isValidating}
						className="gap-2 rounded-xl"
					>
						<RefreshCw className={`h-3 w-3 ${isValidating ? "animate-spin" : ""}`} />
						{retryCount > 0 ? `Retry (${retryCount}/${maxManualRetries})` : "Retry Validation"}
					</Button>
					{retryCount >= maxManualRetries && (
						<span className="text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>
							Max retries reached. Check instance connectivity.
						</span>
					)}
				</div>
			</div>
		</div>
	</div>
);
