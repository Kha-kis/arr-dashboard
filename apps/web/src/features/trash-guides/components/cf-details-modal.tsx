"use client";

import { Palette, X } from "lucide-react";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { SanitizedHtml } from "./sanitized-html";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { CustomFormat, CFDescriptionsListResponse } from "../../../lib/api-client/trash-guides";

const SERVICE_COLORS = {
	RADARR: SERVICE_GRADIENTS.radarr,
	SONARR: SERVICE_GRADIENTS.sonarr,
};

const LocalServiceBadge = ({ service }: { service: "RADARR" | "SONARR" }) => {
	const colors = SERVICE_COLORS[service];
	return (
		<span
			className="inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium"
			style={{
				backgroundColor: `${colors.from}20`,
				border: `1px solid ${colors.from}40`,
				color: colors.from,
			}}
		>
			{service}
		</span>
	);
};

interface CFDetailsModalProps {
	format: CustomFormat & { service: "RADARR" | "SONARR" };
	cfDescriptions?: CFDescriptionsListResponse;
	onClose: () => void;
}

const CFDetailsModal = ({
	format,
	cfDescriptions,
	onClose,
}: CFDetailsModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	const service = format.service.toLowerCase() as "radarr" | "sonarr";
	const descriptions = cfDescriptions?.[service] || [];
	const slug = format.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
	const description = descriptions.find(d => d.cfName === slug);

	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center"
			role="dialog"
			aria-modal="true"
			aria-labelledby="cf-details-title"
		>
			{/* Backdrop */}
			<div
				className="absolute inset-0 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
				onClick={onClose}
			/>

			{/* Modal */}
			<div
				className="relative z-10 w-full max-w-3xl max-h-[80vh] mx-4 rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 fade-in duration-200 overflow-hidden"
				style={{ boxShadow: `0 25px 50px -12px ${themeGradient.glow}` }}
			>
				{/* Header */}
				<div className="sticky top-0 z-10 flex items-center justify-between p-6 border-b border-border/50 bg-card/95 backdrop-blur-xl">
					<div className="flex items-center gap-3">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl"
							style={{
								background: `${SERVICE_COLORS[format.service].from}20`,
								border: `1px solid ${SERVICE_COLORS[format.service].from}40`,
							}}
						>
							<Palette className="h-5 w-5" style={{ color: SERVICE_COLORS[format.service].from }} />
						</div>
						<div>
							<h3 id="cf-details-title" className="text-lg font-bold text-foreground">{format.name}</h3>
							<LocalServiceBadge service={format.service} />
						</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close details dialog"
						className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-card/80 transition-colors"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				{/* Content */}
				<div className="p-6 overflow-y-auto max-h-[calc(80vh-80px)]">
					<div className="space-y-6">
						{/* Description */}
						{description && (
							<div className="space-y-3">
								<h4 className="text-sm font-semibold text-foreground">Description</h4>
								<SanitizedHtml
									html={description.description}
									className="prose prose-sm prose-invert max-w-none text-muted-foreground [&_a]:text-primary [&_a]:no-underline [&_a:hover]:underline"
								/>
							</div>
						)}

						{/* Metadata */}
						<div className="space-y-3">
							<h4 className="text-sm font-semibold text-foreground">Information</h4>
							<div className="rounded-xl border border-border/50 bg-card/30 p-4 space-y-3 text-sm">
								<div className="flex justify-between items-center">
									<span className="text-muted-foreground">TRaSH ID:</span>
									<span className="font-mono text-xs text-foreground bg-muted/30 px-2 py-1 rounded">
										{format.trash_id}
									</span>
								</div>
								<div className="flex justify-between items-center">
									<span className="text-muted-foreground">Conditions:</span>
									<span className="text-foreground font-medium">
										{format.specifications.length}
									</span>
								</div>
							</div>
						</div>

						{/* Specifications/Conditions */}
						<div className="space-y-3">
							<h4 className="text-sm font-semibold text-foreground">Conditions</h4>
							<div className="space-y-2">
								{format.specifications.map((spec, index) => (
									<div
										key={index}
										className="rounded-xl border border-border/50 bg-card/30 p-4 animate-in fade-in"
										style={{
											animationDelay: `${index * 30}ms`,
											animationFillMode: "backwards",
										}}
									>
										<div className="flex items-start justify-between mb-2">
											<div className="flex-1">
												<div className="font-medium text-foreground">{spec.name}</div>
												<div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
													<span>{spec.implementation}</span>
													{spec.negate && (
														<span
															className="px-2 py-0.5 rounded"
															style={{
																backgroundColor: SEMANTIC_COLORS.warning.bg,
																border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
																color: SEMANTIC_COLORS.warning.text,
															}}
														>
															Negated
														</span>
													)}
													{spec.required && (
														<span
															className="px-2 py-0.5 rounded"
															style={{
																backgroundColor: `${themeGradient.from}20`,
																border: `1px solid ${themeGradient.from}40`,
																color: themeGradient.from,
															}}
														>
															Required
														</span>
													)}
												</div>
											</div>
										</div>
										{spec.fields && Object.keys(spec.fields).length > 0 && (
											<div className="mt-3 space-y-1.5 pt-3 border-t border-border/30">
												{Object.entries(spec.fields).map(([key, value]) => (
													<div key={key} className="text-xs flex items-start gap-2">
														<span className="text-muted-foreground shrink-0">{key}:</span>
														<span className="font-mono text-foreground/80 break-all">
															{typeof value === 'object' ? JSON.stringify(value) : String(value)}
														</span>
													</div>
												))}
											</div>
										)}
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

export default CFDetailsModal;
