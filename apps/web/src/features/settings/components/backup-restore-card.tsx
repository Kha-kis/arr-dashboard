import { ShieldAlert } from "lucide-react";

import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

export const BackupRestoreCard = () => {
	return (
		<div className="rounded-xl border border-border/30 bg-muted/10 p-6">
			<div className="space-y-4">
				<div className="flex items-center gap-2">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}20, ${SEMANTIC_COLORS.warning.to}20)`,
							border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
						}}
					>
						<ShieldAlert className="h-5 w-5" style={{ color: SEMANTIC_COLORS.warning.text }} />
					</div>
					<div>
						<h3 className="font-semibold text-foreground">Restore temporarily unavailable</h3>
						<p className="text-xs text-muted-foreground">
							Backup creation and downloads remain available
						</p>
					</div>
				</div>

				<div
					className="rounded-lg p-3 text-sm"
					style={{
						backgroundColor: SEMANTIC_COLORS.warning.bg,
						border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
						color: SEMANTIC_COLORS.warning.text,
					}}
				>
					Restore is disabled until database and secrets recovery can remain consistent across a
					process or host failure. No restore data is read or changed by this version.
				</div>
			</div>
		</div>
	);
};
