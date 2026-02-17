"use client";

/**
 * Template Instance Selector
 *
 * Modal for selecting which instance to deploy a template to.
 * Includes bulk deploy option when multiple instances match.
 */

import { AlertCircle, Layers, Rocket, X } from "lucide-react";

interface TemplateInstanceSelectorProps {
	templateName: string;
	matchingInstances: Array<{ id: string; label: string; service: string }>;
	themeGradient: { from: string; to: string; glow: string };
	onSelectInstance: (instanceId: string, instanceLabel: string) => void;
	onBulkDeploy: () => void;
	onClose: () => void;
}

export const TemplateInstanceSelector = ({
	templateName,
	matchingInstances,
	themeGradient,
	onSelectInstance,
	onBulkDeploy,
	onClose,
}: TemplateInstanceSelectorProps) => (
	<div
		className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-modal p-4 animate-in fade-in duration-200"
		role="dialog"
		aria-modal="true"
		aria-labelledby="deploy-template-title"
	>
		<div className="rounded-2xl shadow-2xl border border-border/50 bg-card/95 backdrop-blur-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-300">
			{/* Header */}
			<div
				className="flex items-center justify-between p-6 border-b border-border/50"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}10, transparent)`,
				}}
			>
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
						}}
					>
						<Rocket className="h-5 w-5" style={{ color: themeGradient.from }} />
					</div>
					<div>
						<h2 id="deploy-template-title" className="text-lg font-semibold text-foreground">Deploy Template</h2>
						<p className="text-sm text-muted-foreground">{templateName}</p>
					</div>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close modal"
					className="rounded-lg p-2 hover:bg-card/80 transition-colors"
				>
					<X className="h-5 w-5" />
				</button>
			</div>

			{/* Instance List */}
			<div className="flex-1 overflow-y-auto p-6">
				{/* Bulk Deploy Button */}
				{matchingInstances.length > 1 && (
					<button
						type="button"
						onClick={onBulkDeploy}
						className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 mb-4 text-sm font-medium transition-all duration-200"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}15)`,
							border: `1px solid ${themeGradient.from}30`,
							color: themeGradient.from,
						}}
					>
						<Layers className="h-5 w-5" />
						Deploy to Multiple Instances ({matchingInstances.length} available)
					</button>
				)}

				<h3 className="text-sm font-medium text-foreground mb-4">Select an instance:</h3>
				<div className="space-y-3">
					{matchingInstances.length > 0 ? (
						matchingInstances.map((instance) => (
							<button
								key={instance.id}
								type="button"
								onClick={() => onSelectInstance(instance.id, instance.label)}
								className="w-full flex items-center justify-between p-4 rounded-xl border border-border/50 bg-card/30 hover:bg-card/50 hover:border-border transition-all text-left group"
							>
								<div>
									<div className="font-medium text-foreground group-hover:text-foreground transition-colors">
										{instance.label}
									</div>
									<div className="text-sm text-muted-foreground mt-1">
										{instance.service}
									</div>
								</div>
								<Rocket
									className="h-5 w-5 transition-transform group-hover:scale-110"
									style={{ color: themeGradient.from }}
								/>
							</button>
						))
					) : (
						<div className="text-center py-12 px-4 rounded-xl border border-dashed border-border/50">
							<AlertCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
							<p className="text-foreground font-medium">No instances available.</p>
							<p className="text-sm text-muted-foreground mt-2">
								Add a Radarr or Sonarr instance in Settings first.
							</p>
						</div>
					)}
				</div>
			</div>

			{/* Footer */}
			<div className="flex items-center justify-end p-6 border-t border-border/50">
				<button
					type="button"
					onClick={onClose}
					className="rounded-xl px-4 py-2.5 text-sm font-medium border border-border/50 bg-card/30 hover:bg-card/50 transition-all"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
);
