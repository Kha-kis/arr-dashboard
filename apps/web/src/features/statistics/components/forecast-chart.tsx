"use client";

import type { BandwidthForecast } from "@arr/shared";
import { TrendingUp } from "lucide-react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { formatBandwidth } from "./chart-primitives";

const DAY_MS = 86_400_000;
const UTC_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const knownRate = (value: number | null | undefined): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
const rate = (value: number | null | undefined) =>
	knownRate(value) ? formatBandwidth(value) : "Unknown";

interface DatedRate {
	date: string;
	value: number | null;
}
interface PlotPoint {
	x: number;
	y: number;
}
const ForecastLine = ({
	historical,
	projected,
	historicalColor,
	forecastColor,
}: {
	historical: DatedRate[];
	projected: DatedRate[];
	historicalColor: string;
	forecastColor: string;
}) => {
	const width = 600;
	const height = 80;
	const dated = [...historical, ...projected].filter((point) =>
		Number.isFinite(Date.parse(point.date)),
	);
	const values = dated.filter((point) => knownRate(point.value));
	if (values.length === 0) return null;
	let max = 1;
	let start = Infinity;
	let end = -Infinity;
	for (const point of dated) {
		const time = Date.parse(point.date);
		start = Math.min(start, time);
		end = Math.max(end, time);
		if (knownRate(point.value)) max = Math.max(max, point.value);
	}
	const position = (point: DatedRate): PlotPoint => ({
		x: end === start ? width / 2 : ((Date.parse(point.date) - start) / (end - start)) * width,
		y: 76 - (point.value! / max) * 72,
	});
	// Each absent day/rate starts a new subpath rather than inventing continuity.
	const segments = (points: DatedRate[]) => {
		const result: PlotPoint[][] = [];
		let previous: DatedRate | undefined;
		for (const point of points) {
			if (!knownRate(point.value) || !Number.isFinite(Date.parse(point.date))) {
				previous = undefined;
				continue;
			}
			if (!previous || Date.parse(point.date) - Date.parse(previous.date) !== DAY_MS)
				result.push([]);
			result[result.length - 1]!.push(position(point));
			previous = point;
		}
		return result;
	};
	const histSegments = segments(historical);
	const last = historical[historical.length - 1];
	const foreSegments = segments(last && projected.length > 0 ? [last, ...projected] : projected);
	const line = (parts: PlotPoint[][]) =>
		parts
			.map((part) => part.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" "))
			.join(" ");
	const area = histSegments
		.map(
			(part) => `${line([part])} L${part[part.length - 1]!.x},${height} L${part[0]!.x},${height} Z`,
		)
		.join(" ");
	return (
		<svg
			width="100%"
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			className="block max-w-full overflow-visible"
			role="img"
			aria-label="Sampled bandwidth peaks and projection"
			aria-description="UTC calendar spacing; gaps are unknown, not zero. Dashed values are projections of sampled complete totals."
		>
			<path d={area} fill={historicalColor} opacity={0.1} />
			<path
				d={line(histSegments)}
				fill="none"
				stroke={historicalColor}
				strokeWidth={2}
				strokeLinecap="round"
			/>
			{projected.length > 0 && (
				<path
					d={line(foreSegments)}
					fill="none"
					stroke={forecastColor}
					strokeWidth={2}
					strokeDasharray="6 4"
					strokeLinecap="round"
				/>
			)}
			{values.map((point) => {
				const p = position(point);
				return (
					<circle
						key={point.date}
						cx={p.x}
						cy={p.y}
						r={3}
						fill={
							historical.some((day) => day.date === point.date) ? historicalColor : forecastColor
						}
					/>
				);
			})}
		</svg>
	);
};

const PeakHoursChart = ({
	peakHours,
	color,
}: {
	peakHours: BandwidthForecast["peakHours"];
	color: string;
}) => {
	if (peakHours.length === 0) return null;
	const hours = new Map(peakHours.map((hour) => [hour.hour, hour]));
	let max = 1;
	for (const hour of peakHours) {
		const value = hour.avgKnownSubtotal ?? hour.avgBandwidth;
		if (knownRate(value)) max = Math.max(max, value);
	}
	return (
		<div>
			<h4 className="text-xs text-muted-foreground mb-3">Hourly Known Subtotals (UTC)</h4>
			<ul
				aria-label="Hourly bandwidth observations (UTC)"
				className="flex items-end gap-[3px]"
				style={{ height: 60 }}
			>
				{UTC_HOURS.map((hour) => {
					const point = hours.get(hour);
					const value = point?.avgKnownSubtotal ?? point?.avgBandwidth;
					const description = `${hour}:00 UTC — known subtotal average: ${rate(value)}; complete total average: ${rate(point?.avgBandwidth)}; observed concurrent average: ${point?.avgConcurrent ?? "Unknown"}`;
					return (
						<li
							key={hour}
							className="flex flex-1 min-w-0 items-end h-full"
							aria-label={description}
							title={description}
						>
							<span
								className="block w-full rounded-t-sm"
								style={{
									height: knownRate(value) ? Math.max(2, (value / max) * 60) : 2,
									backgroundColor: color,
									opacity: knownRate(value) ? 0.3 + (value / max) * 0.7 : 0.1,
								}}
							/>
						</li>
					);
				})}
			</ul>
			<div className="flex justify-between text-[9px] text-muted-foreground mt-1">
				<span>0h</span>
				<span>6h</span>
				<span>12h</span>
				<span>18h</span>
				<span>23h</span>
			</div>
			<p className="text-xs text-muted-foreground mt-2">
				Unknown hours are not zero. Bars show known subtotals, not complete totals or continuous
				demand.
			</p>
		</div>
	);
};

interface ForecastChartProps {
	data: BandwidthForecast | undefined;
	isLoading: boolean;
	isError: boolean;
	service?: "plex" | "jellyfin";
}

export const ForecastChart = ({
	data,
	isLoading,
	isError,
	service = "plex",
}: ForecastChartProps) => {
	const { gradient } = useThemeGradient();
	const serviceLabel = service === "plex" ? "Plex" : "Jellyfin";
	if (isLoading && !data)
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<PremiumSkeleton variant="line" className="h-[80px] w-full" />
			</div>
		);
	if (isError && !data)
		return (
			<PremiumEmptyState
				icon={TrendingUp}
				title="Failed to Load Forecast"
				description={`Could not fetch bandwidth forecast data. Check your ${serviceLabel} connection and try again.`}
			/>
		);
	if (!data)
		return (
			<PremiumEmptyState
				icon={TrendingUp}
				title="No Forecast Observations Yet"
				description="Check source settings and the collection scheduler. Native activity samples are needed before a projection is available."
			/>
		);

	const measurement = data.measurement?.version === 1 ? data.measurement : undefined;
	const collection = measurement?.collection;
	const comparable =
		measurement && measurement.bandwidthBasis !== "mixed" && measurement.bandwidthBasis !== null;
	const canProject =
		comparable && measurement.projectionStatus === "available" && data.forecast.length > 0;
	const projected = canProject
		? data.forecast.map((point) => ({ date: point.date, value: point.predictedPeak }))
		: [];
	const historical = comparable
		? data.historicalDaily.map((day) => ({ date: day.date, value: day.peakBandwidth }))
		: [];
	const dates = [...historical, ...projected].map((point) => point.date);
	const trend =
		!canProject || data.trend === "unknown"
			? "Trend unknown"
			: data.trend === "increasing"
				? "↗ Increasing"
				: data.trend === "decreasing"
					? "↘ Decreasing"
					: "→ Stable";
	const trendColor = !canProject
		? gradient.from
		: data.trend === "increasing"
			? SEMANTIC_COLORS.warning.text
			: data.trend === "decreasing"
				? SEMANTIC_COLORS.success.text
				: gradient.from;
	const noActive = measurement?.observedSnapshots === 0;
	const collectionState = noActive
		? measurement.configuredSources === 0
			? `No configured ${serviceLabel} sources. Check Settings to configure a connection.`
			: collection && collection.failedSnapshots > 0
				? "Collection failed in this window. Check source settings and retry collection."
				: collection && collection.invalidSnapshots > 0
					? "Collection evidence is invalid. Check source settings."
					: collection && collection.idleSnapshots > 0
						? "Successful idle observations recorded; no active rate projection is available."
						: "No observations recorded in this window. Check source settings and the collection scheduler."
		: null;
	const basis =
		measurement?.bandwidthBasis === "encoding-estimate"
			? "Encoding estimate, not measured network traffic."
			: measurement?.bandwidthBasis === "provider-reported"
				? "Provider-reported bandwidth."
				: measurement?.bandwidthBasis === "mixed"
					? "Mixed measurement bases cannot be combined into one rate or projection."
					: "No native bandwidth basis available.";
	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
					<TrendingUp className="h-4 w-4" style={{ color: gradient.from }} />
					Bandwidth Forecast
				</h3>
				<span
					className="text-xs font-medium px-2 py-0.5 rounded-full"
					style={{ backgroundColor: `${trendColor}20`, color: trendColor }}
				>
					{trend}
				</span>
			</div>
			{isError && (
				<p role="status" className="text-xs text-warning">
					Last-known historical data retained; refresh failed. Check the connection and try again.
				</p>
			)}
			<div className="text-xs text-muted-foreground space-y-1">
				{measurement ? (
					<>
						<p>{basis}</p>
						<p>
							{measurement.measuredSessions} of {measurement.observedSessions} session observations
							have known rates; {measurement.completeTotalSnapshots} of{" "}
							{measurement.observedSnapshots} active snapshots have complete totals.
						</p>
						<p>
							Known subtotals are not complete totals when rates are missing. Daily averages and
							peaks of complete totals exclude partial samples; coverage remains explicit.
						</p>
						{collection && (
							<p>
								Collection: {collection.failedSnapshots} failed, {collection.legacySnapshots}{" "}
								legacy/unverified, {collection.invalidSnapshots} invalid, {collection.idleSnapshots}{" "}
								idle observations.
							</p>
						)}
						{collectionState && <p role="status">{collectionState}</p>}
						{!canProject && measurement.projectionStatus !== "mixed-basis" && (
							<p role="status">
								{measurement.projectionStatus === "numeric-unavailable"
									? "Projection unavailable: extrapolated rates exceed the supported numeric range."
									: "Projection unavailable: at least two days with complete native totals of a comparable rate basis are required."}
							</p>
						)}
					</>
				) : (
					<p>
						Legacy/unverified measurements: this response has no native rate coverage evidence.
						Projection unavailable; check source collection.
					</p>
				)}
				<p>
					Per-source sampled peaks, not continuous playback history, simultaneous totals across
					servers, network capacity, or a guarantee of future demand. Gaps are unknown, not zero.
				</p>
			</div>
			{comparable && (
				<div>
					<div className="flex flex-wrap gap-4 text-[10px] text-muted-foreground mb-2">
						<span>Historical complete-sample peak</span>
						{canProject && <span>Projected sampled peak</span>}
					</div>
					<ForecastLine
						historical={historical}
						projected={projected}
						historicalColor={SERVICE_GRADIENTS[service].from}
						forecastColor={SEMANTIC_COLORS.info.text}
					/>
					{dates.length > 1 && (
						<div className="flex justify-between gap-2 text-[10px] text-muted-foreground mt-1 px-1">
							<span>{dates[0]}</span>
							<span>{dates[dates.length - 1]}</span>
						</div>
					)}
				</div>
			)}
			{measurement && data.historicalDaily.length > 0 && (
				<details open={!canProject || data.historicalDaily.length <= 3}>
					<summary className="text-xs text-muted-foreground cursor-pointer">
						Daily sample observations and rate coverage
					</summary>
					<ul
						aria-label="Daily bandwidth observations"
						className="mt-2 space-y-2 text-xs text-muted-foreground"
					>
						{data.historicalDaily.map((day) => {
							const coverage = day.measurement;
							const verified = coverage
								? coverage.bandwidthBasis !== "mixed" && coverage.bandwidthBasis !== null
								: comparable;
							return (
								<li key={day.date} className="break-words">
									<span className="font-medium">{day.date}</span>
									{" — "}
									complete-sample average: {rate(verified ? day.avgBandwidth : null)}; peak:{" "}
									{rate(verified ? day.peakBandwidth : null)}; known subtotal average:{" "}
									{rate(verified ? day.avgKnownSubtotal : null)}; peak:{" "}
									{rate(verified ? day.peakKnownSubtotal : null)}.
									{coverage && (
										<span>
											{" "}
											{coverage.measuredSessions} of {coverage.observedSessions} session
											observations measured;{" "}
											{coverage.bandwidthBasis === "encoding-estimate"
												? "encoding estimate"
												: coverage.bandwidthBasis === "provider-reported"
													? "provider-reported"
													: "basis unknown"}
											; {coverage.completeTotalSnapshots} complete-total samples.
										</span>
									)}
								</li>
							);
						})}
					</ul>
				</details>
			)}
			{measurement && <PeakHoursChart peakHours={data.peakHours} color={gradient.from} />}
		</div>
	);
};
