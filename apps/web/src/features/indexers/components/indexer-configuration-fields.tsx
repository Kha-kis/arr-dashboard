"use client";

import type { ProwlarrIndexerField } from "@arr/shared";
import { formatFieldValue, isApiKeyRelatedField } from "../lib/indexers-utils";
import { Settings } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

/**
 * Premium Configuration Field Card
 */
const FieldCard = ({
	field,
	index,
}: {
	field: ProwlarrIndexerField;
	index: number;
}) => {
	const { gradient: _themeGradient } = useThemeGradient();

	return (
		<div
			className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 transition-all duration-200 hover:bg-card/50 animate-in fade-in slide-in-from-bottom-1"
			style={{
				animationDelay: `${index * 30}ms`,
				animationFillMode: "backwards",
			}}
		>
			<p className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-2">
				{field.label ?? field.name}
			</p>
			<p className="text-sm font-medium text-foreground">
				{formatFieldValue(field.name, field.value)}
			</p>
			{field.helpText && (
				<p className="mt-2 text-xs text-muted-foreground/80 leading-relaxed">
					{field.helpText}
				</p>
			)}
		</div>
	);
};

/**
 * Premium Indexer Configuration Fields
 *
 * Displays configuration fields for an indexer with:
 * - Glassmorphic card styling
 * - Staggered animation
 * - API key field filtering
 * - Help text support
 */
export const IndexerConfigurationFields = ({
	fields,
}: {
	fields: ProwlarrIndexerField[];
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	const filteredFields = fields.filter((field) => !isApiKeyRelatedField(field));

	if (filteredFields.length === 0) {
		return null;
	}

	return (
		<div className="space-y-4">
			{/* Section Header */}
			<div className="flex items-center gap-2">
				<Settings className="h-4 w-4" style={{ color: themeGradient.from }} />
				<p className="text-xs uppercase tracking-wider font-medium text-muted-foreground">
					Configuration
				</p>
			</div>

			{/* Fields Grid */}
			<div className="grid gap-3 sm:grid-cols-2">
				{filteredFields.slice(0, 10).map((field, index) => (
					<FieldCard
						key={field.name}
						field={field}
						index={index}
					/>
				))}
			</div>

			{/* More fields indicator */}
			{filteredFields.length > 10 && (
				<p className="text-xs text-muted-foreground text-center">
					+{filteredFields.length - 10} more configuration fields
				</p>
			)}
		</div>
	);
};
