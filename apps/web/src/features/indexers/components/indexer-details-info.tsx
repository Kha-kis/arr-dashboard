"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import {
	Activity,
	AlertTriangle,
	CheckCircle2,
	Clock,
	Cpu,
	Folder,
	Globe,
	Layers,
	Shield,
	Tag,
	Zap,
} from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { PROTOCOL_COLORS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { formatDateTime, formatResponseTime, protocolLabel } from "../lib/indexers-utils";

/**
 * Stat tile — subtle left-accented cell
 */
const StatTile = ({
	icon: Icon,
	label,
	value,
	accent,
	mono,
}: {
	icon?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	label: string;
	value?: string;
	accent?: string;
	mono?: boolean;
}) => {
	if (!value || value.trim().length === 0) return null;

	return (
		<div className="flex items-start gap-2.5 min-w-0">
			{Icon && (
				<div
					className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-md shrink-0"
					style={{
						backgroundColor: accent ? `${accent}12` : "rgba(var(--border), 0.15)",
					}}
				>
					<Icon
						className="h-3 w-3"
						style={{ color: accent || "rgba(var(--muted-foreground), 0.5)" }}
					/>
				</div>
			)}
			<div className="min-w-0">
				<p className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground/50 leading-none mb-1">
					{label}
				</p>
				<p
					className={`text-[13px] font-medium leading-tight truncate ${mono ? "font-mono tabular-nums" : ""}`}
					style={{ color: accent || "inherit" }}
				>
					{value}
				</p>
			</div>
		</div>
	);
};

/**
 * Hero success gauge — large ring with animated glow
 */
const SuccessGauge = ({ rate }: { rate?: number }) => {
	const size = 80;
	const r = 32;
	const viewBox = `0 0 ${size} ${size}`;
	const cx = size / 2;
	const cy = size / 2;
	const circumference = 2 * Math.PI * r;

	if (rate === undefined) {
		return (
			<div className="flex flex-col items-center gap-2">
				<div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
					<svg viewBox={viewBox} width={size} height={size} className="-rotate-90">
						<circle
							cx={cx}
							cy={cy}
							r={r}
							fill="none"
							stroke="rgba(var(--border), 0.12)"
							strokeWidth="4"
						/>
					</svg>
					<span className="absolute text-xs font-medium text-muted-foreground/30">N/A</span>
				</div>
				<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/40">
					Success Rate
				</span>
			</div>
		);
	}

	const normalized = rate > 1 ? rate / 100 : rate;
	const pct = Math.round(normalized * 100);
	const dashOffset = circumference - circumference * Math.min(normalized, 1);

	const gaugeColor: string =
		normalized < 0.5
			? SEMANTIC_COLORS.error.from
			: normalized < 0.9
				? SEMANTIC_COLORS.warning.from
				: SEMANTIC_COLORS.success.from;

	return (
		<div className="flex flex-col items-center gap-2">
			<div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
				{/* Glow backdrop */}
				<div
					className="absolute inset-2 rounded-full"
					style={{
						background: `radial-gradient(circle, ${gaugeColor}10 0%, transparent 70%)`,
					}}
				/>
				<svg viewBox={viewBox} width={size} height={size} className="-rotate-90">
					{/* Track */}
					<circle
						cx={cx}
						cy={cy}
						r={r}
						fill="none"
						stroke="rgba(var(--border), 0.1)"
						strokeWidth="4"
					/>
					{/* Value arc */}
					<circle
						cx={cx}
						cy={cy}
						r={r}
						fill="none"
						stroke={gaugeColor}
						strokeWidth="4.5"
						strokeLinecap="round"
						strokeDasharray={`${circumference}`}
						strokeDashoffset={`${dashOffset}`}
						style={{
							filter: `drop-shadow(0 0 6px ${gaugeColor}60)`,
							transition: "stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1)",
						}}
					/>
				</svg>
				<div className="absolute flex flex-col items-center">
					<span className="text-lg font-bold tabular-nums leading-none" style={{ color: gaugeColor }}>
						{pct}
					</span>
					<span className="text-[9px] font-medium text-muted-foreground/40 mt-0.5">%</span>
				</div>
			</div>
			<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/40">
				Success Rate
			</span>
		</div>
	);
};

/**
 * Perf metric — compact vertical stat with subtle icon
 */
const PerfMetric = ({
	icon: Icon,
	label,
	value,
	color,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	label: string;
	value?: string;
	color?: string;
}) => {
	const hasValue = value && value !== "–";
	return (
		<div className="flex items-center gap-2.5">
			<Icon
				className="h-3.5 w-3.5 shrink-0"
				style={{ color: color || "rgba(var(--muted-foreground), 0.35)" }}
			/>
			<div>
				<p className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground/45 leading-none mb-0.5">
					{label}
				</p>
				<p
					className={`text-[13px] font-medium leading-tight tabular-nums ${hasValue ? "text-foreground" : "text-muted-foreground/25"}`}
				>
					{hasValue ? value : "N/A"}
				</p>
			</div>
		</div>
	);
};

/**
 * Capability/category pill with subtle glow
 */
const TagPill = ({ label, color }: { label: string; color: string }) => (
	<span
		className="rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wide transition-colors"
		style={{
			backgroundColor: `${color}0c`,
			border: `1px solid ${color}1a`,
			color: `${color}b0`,
		}}
	>
		{label}
	</span>
);

/**
 * Indexer Details Info — Refined Console Layout
 *
 * Three visual zones:
 * 1. Info ribbon — key metadata in a clean row
 * 2. Performance panel — hero gauge + perf stats
 * 3. Tags bar — capabilities and categories as compact pills
 */
export const IndexerDetailsInfo = ({
	detail,
	indexer,
}: {
	detail: ProwlarrIndexerDetails;
	indexer: ProwlarrIndexer;
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	const stats = detail.stats;
	const capabilities = detail.capabilities ?? indexer.capabilities ?? [];
	const categories = detail.categories ?? [];
	const protocol = detail.protocol ?? indexer.protocol;

	const protocolColor =
		protocol === "torrent" ? PROTOCOL_COLORS.torrent : PROTOCOL_COLORS.usenet;

	return (
		<div className="space-y-0">
			{/* Zone 1: Info ribbon */}
			<div
				className="rounded-lg border border-border/20 bg-card/20 p-4 animate-in fade-in duration-300"
				style={{ animationDelay: "50ms", animationFillMode: "backwards" }}
			>
				<div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
					<StatTile
						icon={Cpu}
						label="Implementation"
						value={detail.implementationName ?? "Unknown"}
						accent={themeGradient.from}
					/>
					<StatTile
						icon={Globe}
						label="Protocol"
						value={protocolLabel(protocol)}
						accent={protocolColor}
					/>
					<StatTile
						icon={Layers}
						label="Priority"
						value={
							typeof detail.priority === "number"
								? detail.priority.toString()
								: detail.priority === 0
									? "0"
									: undefined
						}
						mono
					/>
					<StatTile
						icon={Folder}
						label="App Profile"
						value={
							typeof detail.appProfileId === "number"
								? detail.appProfileId.toString()
								: "Default"
						}
						mono
					/>
					<StatTile
						icon={Shield}
						label="Privacy"
						value={detail.privacy ?? undefined}
					/>
					<StatTile
						icon={Globe}
						label="Language"
						value={detail.language ?? undefined}
					/>
				</div>
			</div>

			{/* Zone 2: Performance panel */}
			{stats && (
				<div
					className="mt-3 rounded-lg border border-border/20 bg-card/20 p-4 animate-in fade-in duration-300"
					style={{ animationDelay: "120ms", animationFillMode: "backwards" }}
				>
					<div className="flex items-center gap-1.5 mb-4">
						<Zap className="h-3.5 w-3.5" style={{ color: themeGradient.from }} />
						<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/50">
							Performance
						</span>
					</div>

					<div className="flex flex-col sm:flex-row items-center gap-6">
						{/* Hero gauge */}
						<SuccessGauge rate={stats.successRate} />

						{/* Metrics grid */}
						<div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-4">
							<PerfMetric
								icon={Activity}
								label="Avg Response"
								value={formatResponseTime(stats.averageResponseTime)}
								color={themeGradient.from}
							/>
							<PerfMetric
								icon={Clock}
								label="Last Check"
								value={formatDateTime(stats.lastCheck)}
							/>
							<PerfMetric
								icon={AlertTriangle}
								label="Last Failure"
								value={formatDateTime(stats.lastFailure)}
								color={
									stats.lastFailure
										? SEMANTIC_COLORS.error.from
										: undefined
								}
							/>
							{typeof stats.grabs === "number" && (
								<PerfMetric
									icon={CheckCircle2}
									label="Total Grabs"
									value={stats.grabs.toLocaleString()}
									color={SEMANTIC_COLORS.success.from}
								/>
							)}
							{typeof stats.fails === "number" && stats.fails > 0 && (
								<PerfMetric
									icon={AlertTriangle}
									label="Total Failures"
									value={stats.fails.toLocaleString()}
									color={SEMANTIC_COLORS.error.from}
								/>
							)}
						</div>
					</div>
				</div>
			)}

			{/* Zone 3: Tags bar */}
			{(capabilities.length > 0 || categories.length > 0) && (
				<div
					className="mt-3 flex flex-wrap items-center gap-1.5 px-1 animate-in fade-in duration-300"
					style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
				>
					{capabilities.length > 0 && (
						<>
							<span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground/40 mr-1 shrink-0">
								<Tag className="h-2.5 w-2.5" />
								Caps
							</span>
							{capabilities.map((cap) => (
								<TagPill key={cap} label={cap} color={themeGradient.from} />
							))}
						</>
					)}

					{categories.length > 0 && (
						<>
							{capabilities.length > 0 && (
								<span className="w-px h-4 bg-border/20 mx-1.5" />
							)}
							<span className="text-[10px] font-semibold text-muted-foreground/40 mr-1 shrink-0">
								Categories
							</span>
							{categories.map((cat) => (
								<TagPill
									key={cat}
									label={String(cat)}
									color={themeGradient.fromMuted || themeGradient.from}
								/>
							))}
						</>
					)}
				</div>
			)}
		</div>
	);
};
