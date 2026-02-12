"use client";

import {
	Download,
	X,
	ChevronDown,
	AlertCircle,
	Loader2,
} from "lucide-react";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

interface InstanceOption {
	id: string;
	label: string;
	service: string;
}

interface DeployCFModalProps {
	selectedCount: number;
	hasInstances: boolean;
	availableInstances: InstanceOption[];
	selectedInstance: string;
	onInstanceChange: (id: string) => void;
	onDeploy: () => void;
	onClose: () => void;
	isPending: boolean;
}

const DeployCFModal = ({
	selectedCount,
	hasInstances,
	availableInstances,
	selectedInstance,
	onInstanceChange,
	onDeploy,
	onClose,
	isPending,
}: DeployCFModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center"
			role="dialog"
			aria-modal="true"
			aria-labelledby="deploy-cf-title"
		>
			{/* Backdrop */}
			<div
				className="absolute inset-0 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
				onClick={() => !isPending && onClose()}
			/>

			{/* Modal */}
			<div
				className="relative z-10 w-full max-w-md mx-4 rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl p-6 shadow-2xl animate-in zoom-in-95 fade-in duration-200"
				style={{ boxShadow: `0 25px 50px -12px ${themeGradient.glow}` }}
			>
				{/* Header */}
				<div className="flex items-center justify-between mb-6">
					<div className="flex items-center gap-3">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Download className="h-5 w-5" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h3 id="deploy-cf-title" className="text-lg font-bold text-foreground">Deploy Custom Formats</h3>
							<p className="text-sm text-muted-foreground">
								{selectedCount} format{selectedCount !== 1 ? "s" : ""} selected
							</p>
						</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						disabled={isPending}
						aria-label="Close deploy dialog"
						className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-card/80 transition-colors disabled:opacity-50"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				{/* Content */}
				<div className="space-y-4 mb-6">
					{!hasInstances ? (
						<div
							className="rounded-xl p-4"
							style={{
								backgroundColor: SEMANTIC_COLORS.warning.bg,
								border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
							}}
						>
							<div className="flex items-start gap-3">
								<AlertCircle className="h-5 w-5 mt-0.5" style={{ color: SEMANTIC_COLORS.warning.from }} />
								<div>
									<p className="font-medium text-foreground">No instances configured</p>
									<p className="text-sm text-muted-foreground mt-1">
										Configure at least one Radarr or Sonarr instance in Settings first.
									</p>
								</div>
							</div>
						</div>
					) : availableInstances.length === 0 ? (
						<div
							className="rounded-xl p-4"
							style={{
								backgroundColor: SEMANTIC_COLORS.warning.bg,
								border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
							}}
						>
							<div className="flex items-start gap-3">
								<AlertCircle className="h-5 w-5 mt-0.5" style={{ color: SEMANTIC_COLORS.warning.from }} />
								<div>
									<p className="font-medium text-foreground">No compatible instances</p>
									<p className="text-sm text-muted-foreground mt-1">
										Selected formats are from different services. Please select formats from only one service type.
									</p>
								</div>
							</div>
						</div>
					) : (
						<div className="space-y-2">
							<label className="text-sm font-medium text-foreground">Select Instance</label>
							<div className="relative">
								<select
									value={selectedInstance}
									onChange={(e) => onInstanceChange(e.target.value)}
									className="w-full appearance-none rounded-xl border border-border/50 bg-card/50 px-4 py-3 pr-10 text-sm text-foreground focus:outline-hidden focus:ring-2 transition-all"
									style={{ ["--tw-ring-color" as string]: themeGradient.from }}
								>
									<option value="">Choose an instance...</option>
									{availableInstances.map((instance) => (
										<option key={instance.id} value={instance.id}>
											{instance.label} ({instance.service})
										</option>
									))}
								</select>
								<ChevronDown className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex justify-end gap-3">
					<button
						type="button"
						onClick={onClose}
						disabled={isPending}
						className="rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onDeploy}
						disabled={!selectedInstance || availableInstances.length === 0 || isPending}
						className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
						}}
					>
						{isPending ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Deploying...
							</>
						) : (
							<>
								<Download className="h-4 w-4" />
								Deploy
							</>
						)}
					</button>
				</div>
			</div>
		</div>
	);
};

export default DeployCFModal;
