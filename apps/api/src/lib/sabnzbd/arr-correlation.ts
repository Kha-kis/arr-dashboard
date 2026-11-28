type Library = { service: "sonarr" | "radarr"; title: string; instanceLabel: string };
type ArrQueueRecord = Record<string, unknown>;
type ArrDownloadClient = Record<string, unknown>;
export type ArrService = {
	id: string;
	label: string;
	baseUrl: string;
	service: "SONARR" | "RADARR";
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials?: string | null;
	httpAuthEncryptionIv?: string | null;
	[key: string]: unknown;
};
type ArrFactory = {
	createSonarrClient(
		instance: ArrService,
		options: { timeout: number },
	): {
		downloadClient: { getAll(): Promise<unknown> };
		queue: { get(options: Record<string, unknown>): Promise<unknown> };
	};
	createRadarrClient(
		instance: ArrService,
		options: { timeout: number },
	): {
		downloadClient: { getAll(): Promise<unknown> };
		queue: { get(options: Record<string, unknown>): Promise<unknown> };
	};
};

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function scalar(value: unknown): string {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value).trim()
		: "";
}

function field(config: ArrDownloadClient, name: string): unknown {
	if (!Array.isArray(config.fields)) return undefined;
	const values = config.fields.filter((raw) => scalar(record(raw).name) === name);
	return values.length === 1 ? record(values[0]).value : undefined;
}

function canonicalEndpoint(value: string): string | null {
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			return null;
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		return `${url.origin}${url.pathname}`;
	} catch {
		return null;
	}
}

function configuredSabEndpoint(config: ArrDownloadClient): string | null {
	const host = scalar(field(config, "host"));
	const portText = scalar(field(config, "port"));
	const sslValue = field(config, "useSsl");
	const urlBaseValue = scalar(field(config, "urlBase"));
	const port = Number(portText);
	if (
		!host ||
		/[\s/@?#]/.test(host) ||
		!(sslValue === true || sslValue === false || sslValue === "true" || sslValue === "false") ||
		!/^\d+$/.test(portText) ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535 ||
		/[?#]/.test(urlBaseValue)
	)
		return null;
	const protocol = sslValue === true || sslValue === "true" ? "https" : "http";
	const path = urlBaseValue ? `/${urlBaseValue.replace(/^\/+|\/+$/g, "")}` : "/";
	return canonicalEndpoint(`${protocol}://${host}:${port}${path}`);
}

function configuredClients(value: unknown): ArrDownloadClient[] | null {
	if (!Array.isArray(value) || value.length > 200) return null;
	return value.map(record);
}

function queueRecords(value: unknown): ArrQueueRecord[] | null {
	const records = record(value).records;
	if (!Array.isArray(records) || records.length > 100) return null;
	return records.map(record);
}

function positiveId(value: unknown): number | null {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Correlate only when an exact SAB endpoint, unique configured client name,
 * opaque download ID, and typed Sonarr/Radarr media identity all agree.
 * Any ambiguity or partial provider result leaves the SAB row unassociated.
 */
export async function correlateSabQueue(
	factory: ArrFactory,
	sabBaseUrl: string,
	sabJobs: readonly { nzoId: string }[],
	arrInstances: readonly ArrService[],
): Promise<Map<string, Library>> {
	const associations = new Map<string, Library>();
	if (arrInstances.length > 10 || sabJobs.length > 100) return associations;
	const target = canonicalEndpoint(sabBaseUrl);
	if (!target) return associations;
	const allMatches = new Map<string, Library[]>();
	await Promise.all(
		arrInstances.map(async (instance) => {
			try {
				const client =
					instance.service === "SONARR"
						? factory.createSonarrClient(instance, { timeout: 4_000 })
						: instance.service === "RADARR"
							? factory.createRadarrClient(instance, { timeout: 4_000 })
							: null;
				if (!client) return;
				const [rawConfigs, rawQueue] = await Promise.all([
					client.downloadClient.getAll(),
					client.queue.get({ pageSize: 100 }),
				]);
				const configs = configuredClients(rawConfigs);
				const records = queueRecords(rawQueue);
				if (!configs || !records) return;
				const matchingConfigs = configs.filter(
					(config) =>
						config.implementation === "SABnzbd" && configuredSabEndpoint(config) === target,
				);
				const names = matchingConfigs.map((config) => scalar(config.name)).filter(Boolean);
				for (const row of records) {
					const downloadId = scalar(row.downloadId);
					const clientName = scalar(row.downloadClient);
					if (!downloadId || !clientName || !names.includes(clientName)) continue;
					const matchingNameCount = names.filter((name) => name === clientName).length;
					if (matchingNameCount !== 1) continue;
					const rawTitle =
						instance.service === "SONARR"
							? scalar(row.seriesTitle ?? record(row.series).title)
							: scalar(row.movieTitle ?? record(row.movie).title);
					const title = rawTitle
						.replace(/https?:\/\/\S+/gi, "[URL]")
						.replace(/(?:[A-Za-z]:\\|\/)\S*/g, "[path]")
						.replace(/[\r\n\t]+/g, " ")
						.slice(0, 240);
					const mediaId = positiveId(instance.service === "SONARR" ? row.seriesId : row.movieId);
					if (!title || !mediaId) continue;
					const found = allMatches.get(downloadId) ?? [];
					found.push({
						service: instance.service === "SONARR" ? "sonarr" : "radarr",
						title,
						instanceLabel: instance.label.slice(0, 120),
					});
					allMatches.set(downloadId, found);
				}
			} catch {
				// Correlation is optional, read-only enrichment; provider failures never become a match.
			}
		}),
	);
	for (const job of sabJobs) {
		const matches = allMatches.get(job.nzoId);
		if (matches?.length === 1) associations.set(job.nzoId, matches[0]!);
	}
	return associations;
}
