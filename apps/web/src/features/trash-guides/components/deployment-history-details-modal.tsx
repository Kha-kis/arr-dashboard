"use client";

import { useDeploymentHistoryDetail } from "../../../hooks/api/useDeploymentHistory";
import { format } from "date-fns";
import { History, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import {
	LegacyDialog,
	LegacyDialogHeader,
	LegacyDialogTitle,
	LegacyDialogDescription,
	LegacyDialogContent,
	LegacyDialogFooter,
} from "../../../components/ui";
import { Button, Skeleton } from "../../../components/ui";

interface DeploymentHistoryDetailsModalProps {
	historyId: string;
	onClose: () => void;
	onUndeploy?: (historyId: string) => void;
}

export function DeploymentHistoryDetailsModal({
	historyId,
	onClose,
	onUndeploy,
}: DeploymentHistoryDetailsModalProps) {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const { data, isLoading, error } = useDeploymentHistoryDetail(historyId);

	return (
		<LegacyDialog open={true} onOpenChange={onClose} size="lg">
			<LegacyDialogHeader
				icon={<History className="h-6 w-6" style={{ color: themeGradient.from }} />}
			>
				<div>
					<LegacyDialogTitle>Deployment Details</LegacyDialogTitle>
					<LegacyDialogDescription>
						View details of this deployment
					</LegacyDialogDescription>
				</div>
			</LegacyDialogHeader>

			<LegacyDialogContent className="space-y-6">
				{isLoading && (
					<div className="space-y-4">
						<Skeleton className="h-24 w-full" />
						<Skeleton className="h-32 w-full" />
						<Skeleton className="h-48 w-full" />
					</div>
				)}

				{error && (
					<div
						className="rounded-xl p-4"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
						}}
					>
						<div className="flex items-start gap-3">
							<AlertCircle
								className="h-5 w-5 mt-0.5 shrink-0"
								style={{ color: SEMANTIC_COLORS.error.from }}
							/>
							<div>
								<p className="text-sm font-medium text-foreground">
									Failed to load deployment details
								</p>
								<p className="text-sm text-muted-foreground mt-1">{error.message}</p>
							</div>
						</div>
					</div>
				)}

				{data?.data && (
					<>
						{/* Overview Section */}
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4">
							<h3 className="text-sm font-medium text-foreground mb-3">Overview</h3>
							<div className="grid grid-cols-2 gap-4">
								<InfoField
									label="Deployed At"
									value={format(
										new Date(data.data.deployedAt),
										"MMM d, yyyy 'at' h:mm a",
									)}
								/>
								<InfoField
									label="Duration"
									value={
										data.data.duration ? `${data.data.duration} seconds` : "N/A"
									}
								/>
								<InfoField label="Status" value={data.data.status} />
								<InfoField label="Deployed By" value={data.data.deployedBy} />
								{data.data.rolledBack && (
									<InfoField
										label="Rolled Back"
										value={
											data.data.rolledBackAt
												? format(
														new Date(data.data.rolledBackAt),
														"MMM d, yyyy 'at' h:mm a",
													)
												: "Yes"
										}
									/>
								)}
							</div>
						</div>

						{/* Instance & Template Section */}
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4">
							<h3 className="text-sm font-medium text-foreground mb-3">
								Instance & Template
							</h3>
							<div className="grid grid-cols-2 gap-4">
								{data.data.instance && (
									<>
										<InfoField
											label="Instance"
											value={data.data.instance.label}
										/>
										<InfoField
											label="Instance Service"
											value={data.data.instance.service}
										/>
									</>
								)}
								{data.data.template && (
									<>
										<InfoField label="Template" value={data.data.template.name} />
										<InfoField
											label="Template Type"
											value={data.data.template.serviceType}
										/>
										{data.data.template.description && (
											<div className="col-span-2">
												<InfoField
													label="Description"
													value={data.data.template.description}
												/>
											</div>
										)}
									</>
								)}
							</div>
						</div>

						{/* Results Section */}
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4">
							<h3 className="text-sm font-medium text-foreground mb-3">Results</h3>
							<div className="grid grid-cols-3 gap-4">
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.success.text }}>Applied</p>
									<p className="text-2xl font-semibold" style={{ color: SEMANTIC_COLORS.success.from }}>
										{data.data.appliedCFs}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>Failed</p>
									<p className="text-2xl font-semibold" style={{ color: SEMANTIC_COLORS.error.from }}>
										{data.data.failedCFs}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: themeGradient.from }}>Total</p>
									<p className="text-2xl font-semibold" style={{ color: themeGradient.from }}>
										{data.data.totalCFs}
									</p>
								</div>
							</div>
						</div>

						{/* Applied Configs Section */}
						{data.data.appliedConfigs && data.data.appliedConfigs.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-foreground">
									Applied Custom Formats ({data.data.appliedConfigs.length})
								</h3>
								<div
									className="rounded-xl divide-y max-h-48 overflow-y-auto"
									style={{
										backgroundColor: SEMANTIC_COLORS.success.bg,
										border: `1px solid ${SEMANTIC_COLORS.success.border}`,
									}}
								>
									{data.data.appliedConfigs.map((config, index) => (
										<div
											key={index}
											className="px-3 py-2 text-sm flex items-center justify-between"
											style={{
												borderColor: SEMANTIC_COLORS.success.border,
											}}
										>
											<div className="flex items-center gap-2">
												<CheckCircle2 className="h-3.5 w-3.5" style={{ color: SEMANTIC_COLORS.success.from }} />
												<span className="text-foreground">{config.name}</span>
											</div>
											<span
												className="px-2 py-0.5 rounded-full text-xs font-medium capitalize"
												style={{
													backgroundColor: `${SEMANTIC_COLORS.success.from}15`,
													color: SEMANTIC_COLORS.success.text,
												}}
											>
												{config.action}
											</span>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Failed Configs Section */}
						{data.data.failedConfigs && data.data.failedConfigs.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
									Failed Custom Formats ({data.data.failedConfigs.length})
								</h3>
								<div
									className="rounded-xl divide-y max-h-48 overflow-y-auto"
									style={{
										backgroundColor: SEMANTIC_COLORS.error.bg,
										border: `1px solid ${SEMANTIC_COLORS.error.border}`,
									}}
								>
									{data.data.failedConfigs.map((config, index) => (
										<div
											key={index}
											className="px-3 py-2 text-sm"
											style={{
												borderColor: SEMANTIC_COLORS.error.border,
											}}
										>
											<div className="flex items-center gap-2">
												<XCircle className="h-3.5 w-3.5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
												<span className="font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>{config.name}</span>
											</div>
											{config.error && (
												<div className="text-xs mt-1 ml-5.5" style={{ color: SEMANTIC_COLORS.error.from }}>{config.error}</div>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						{/* Errors Section */}
						{data.data.errors && (
							<div
								className="rounded-xl p-4"
								style={{
									backgroundColor: SEMANTIC_COLORS.error.bg,
									border: `1px solid ${SEMANTIC_COLORS.error.border}`,
								}}
							>
								<div className="flex items-start gap-3">
									<AlertCircle
										className="h-5 w-5 mt-0.5 shrink-0"
										style={{ color: SEMANTIC_COLORS.error.from }}
									/>
									<div>
										<p className="text-sm font-medium text-foreground">Errors</p>
										<pre
											className="text-xs whitespace-pre-wrap font-mono mt-2"
											style={{ color: SEMANTIC_COLORS.error.from }}
										>
											{data.data.errors}
										</pre>
									</div>
								</div>
							</div>
						)}

						{/* Warnings Section */}
						{data.data.warnings && (
							<div
								className="rounded-xl p-4"
								style={{
									backgroundColor: SEMANTIC_COLORS.warning.bg,
									border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
								}}
							>
								<div className="flex items-start gap-3">
									<AlertCircle
										className="h-5 w-5 mt-0.5 shrink-0"
										style={{ color: SEMANTIC_COLORS.warning.from }}
									/>
									<div>
										<p className="text-sm font-medium text-foreground">Warnings</p>
										<pre
											className="text-xs whitespace-pre-wrap font-mono mt-2"
											style={{ color: SEMANTIC_COLORS.warning.from }}
										>
											{data.data.warnings}
										</pre>
									</div>
								</div>
							</div>
						)}

						{/* Backup Info Section */}
						{data.data.backup && (
							<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4">
								<h3 className="text-sm font-medium text-foreground mb-3">Backup</h3>
								<InfoField
									label="Backup Created"
									value={format(
										new Date(data.data.backup.createdAt),
										"MMM d, yyyy 'at' h:mm a",
									)}
								/>
								<p className="text-xs text-muted-foreground mt-2">
									A backup was created before this deployment.
								</p>
							</div>
						)}
					</>
				)}
			</LegacyDialogContent>

			<LegacyDialogFooter>
				<Button variant="ghost" onClick={onClose} className="rounded-xl">
					Close
				</Button>
				{data?.data &&
					!data.data.rolledBack &&
					onUndeploy && (
						<Button
							className="gap-2 rounded-xl font-medium"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.from,
								color: "white",
							}}
							onClick={() => onUndeploy(historyId)}
							title="Remove Custom Formats deployed by this template (shared CFs will be kept)"
						>
							Undeploy
						</Button>
					)}
			</LegacyDialogFooter>
		</LegacyDialog>
	);
}

function InfoField({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-xs text-muted-foreground mb-1">{label}</div>
			<div className="text-sm font-medium text-foreground">{value}</div>
		</div>
	);
}
