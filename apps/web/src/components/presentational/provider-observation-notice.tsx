import type {
	ProviderObservationAvailability,
	ProviderObservationDomain,
	ProviderObservationStatus,
	ProviderObservationStatusEnvelope,
	ProviderUiCondition,
} from "@arr/shared";
import { aggregateProviderObservationUi } from "@arr/shared";
import { AlertTriangle, Clock3 } from "lucide-react";
import { SEMANTIC_COLORS } from "../../lib/theme-gradients";

export type ProviderObservationNoticeProps = {
	providerStatus?:
		| ProviderObservationStatus
		| ProviderObservationStatusEnvelope
		| readonly (ProviderObservationStatus | ProviderObservationStatusEnvelope | undefined)[];
	requiredDomains?: readonly (readonly ProviderObservationDomain[] | undefined)[];
	isError?: boolean;
	label?: string;
};

export function resolveProviderObservationAvailability(
	providerStatus: ProviderObservationNoticeProps["providerStatus"],
	isError = false,
): ProviderObservationAvailability | undefined {
	let statuses: readonly { availability: ProviderObservationAvailability }[];
	if (Array.isArray(providerStatus)) {
		const statusValues = providerStatus as unknown as readonly (
			| ProviderObservationStatus
			| ProviderObservationStatusEnvelope
			| undefined
		)[];
		statuses = statusValues
			.filter((status): status is NonNullable<typeof status> => status !== undefined)
			.map((status) => ({ availability: status.availability }));
	} else if (providerStatus === undefined) {
		statuses = [];
	} else {
		const directStatus = providerStatus as
			| ProviderObservationStatus
			| ProviderObservationStatusEnvelope;
		statuses = [{ availability: directStatus.availability }];
	}
	const availabilities = statuses.map(({ availability }) => availability);
	if (isError) availabilities.push("unavailable");
	if (availabilities.length === 0) return undefined;
	if (availabilities.every((availability) => availability === "current")) return "current";
	if (availabilities.every((availability) => availability === "last-known")) return "last-known";
	if (availabilities.every((availability) => availability === "unavailable")) return "unavailable";
	return "partial";
}

const noticeCopy = {
	"informational-gap": {
		heading: "Showing current mapped data",
		detail: "Some unsupported items were excluded.",
	},
	collecting: {
		heading: "Media-server data is being collected",
		detail: "Available results remain visible while collection continues.",
	},
	"retryable-failure": {
		heading: "Media-server refresh needs attention",
		detail: "Available results may be older while refresh is retried from Settings.",
	},
	"identity-action-required": {
		heading: "Media-server identity needs verification",
		detail: "Verify the service identity in Settings before refreshing data.",
	},
	"last-known": {
		heading: "Showing last-known media-server data",
		detail: "The latest observation may be stale.",
	},
	partial: {
		heading: "Media-server data is incomplete",
		detail: "Showing available results; some configured sources did not provide complete coverage.",
	},
	unavailable: {
		heading: "Media-server data is unavailable",
		detail: "Results may be missing or stale and are not presented as current.",
	},
} as const;

type ProviderObservationNoticeSource = {
	key: string;
	status: ProviderObservationStatus;
	requiredDomains?: readonly ProviderObservationDomain[];
};

function sourcesForUi(
	providerStatus: ProviderObservationNoticeProps["providerStatus"],
	requiredDomains: ProviderObservationNoticeProps["requiredDomains"] = [],
): ProviderObservationNoticeSource[] {
	const values = Array.isArray(providerStatus) ? providerStatus : [providerStatus];
	return values.flatMap((value, valueIndex) => {
		if (!value) return [];
		const domains = requiredDomains[valueIndex];
		if ("sources" in value)
			return value.sources.map((source: ProviderObservationStatusEnvelope["sources"][number]) => ({
				key: `${source.instanceId}:${source.cacheType}`,
				status: source.status,
				requiredDomains: domains,
			}));
		return [{ key: `direct:${valueIndex}`, status: value, requiredDomains: domains }];
	});
}

export function resolveProviderObservationUiCondition(
	providerStatus: ProviderObservationNoticeProps["providerStatus"],
	isError = false,
	requiredDomains: ProviderObservationNoticeProps["requiredDomains"] = [],
): ProviderUiCondition | undefined {
	const statuses = sourcesForUi(providerStatus, requiredDomains).map(
		({ status, requiredDomains: sourceDomains }) => ({
			status,
			requiredDomains: sourceDomains,
		}),
	);
	const projected = aggregateProviderObservationUi(statuses, isError);
	if (projected) return projected;
	const availability = resolveProviderObservationAvailability(providerStatus, isError);
	if (!availability) return undefined;
	return availability === "current" ? "current" : "unavailable";
}

export function ProviderObservationNotice({
	providerStatus,
	requiredDomains,
	isError = false,
	label,
}: ProviderObservationNoticeProps) {
	const availability = resolveProviderObservationAvailability(providerStatus, isError);
	const condition = resolveProviderObservationUiCondition(providerStatus, isError, requiredDomains);
	const sources = sourcesForUi(providerStatus, requiredDomains);
	if (!condition || condition === "current") return null;

	const copy =
		condition === "unavailable" && availability === "last-known"
			? noticeCopy["last-known"]
			: condition === "unavailable" && availability === "partial" && sources.length === 0
				? noticeCopy.partial
				: condition === "unavailable"
					? noticeCopy.unavailable
					: condition === "informational-gap" ||
							condition === "collecting" ||
							condition === "retryable-failure" ||
							condition === "identity-action-required"
						? noticeCopy[condition]
						: noticeCopy[availability === "last-known" ? "last-known" : "partial"];
	if (!copy) return null;
	const Icon = condition === "collecting" || availability === "last-known" ? Clock3 : AlertTriangle;
	const colors =
		condition === "retryable-failure" ||
		(condition === "unavailable" && availability !== "last-known" && availability !== "partial")
			? SEMANTIC_COLORS.error
			: SEMANTIC_COLORS.warning;

	return (
		<div
			role="status"
			aria-live="polite"
			aria-atomic="true"
			className="flex min-w-0 items-start gap-2 border-t px-4 py-3 text-sm text-muted-foreground"
			style={{ backgroundColor: colors.bg, borderColor: colors.border }}
		>
			<Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" style={{ color: colors.text }} />
			<div className="min-w-0">
				<p className="font-medium" style={{ color: colors.text }}>
					{copy.heading}
				</p>
				<p className="break-words text-xs">
					{label ? `${label}: ` : ""}
					{copy.detail}
				</p>
			</div>
		</div>
	);
}
