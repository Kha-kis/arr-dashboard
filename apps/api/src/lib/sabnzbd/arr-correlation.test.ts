import { describe, expect, it, vi } from "vitest";
import { correlateSabQueue } from "./arr-correlation.js";

const instance = {
	id: "sonarr-1",
	label: "TV library",
	service: "SONARR" as const,
	baseUrl: "http://sonarr",
	encryptedApiKey: "encrypted",
	encryptionIv: "iv",
};
const job = { nzoId: "opaque-queue-id" };
const config = {
	id: 4,
	name: "SAB local",
	implementation: "SABnzbd",
	fields: [
		{ name: "host", value: "sab.local" },
		{ name: "port", value: 8080 },
		{ name: "useSsl", value: false },
		{ name: "urlBase", value: "" },
		{ name: "apiKey", value: "must-not-escape" },
	],
};

function factory(downloadClients: unknown, queue: unknown) {
	const createSonarrClient = vi.fn(() => ({
		downloadClient: { getAll: vi.fn().mockResolvedValue(downloadClients) },
		queue: { get: vi.fn().mockResolvedValue(queue) },
	}));
	return { createSonarrClient, createRadarrClient: vi.fn() };
}

describe("SABnzbd exact ARR correlation", () => {
	it("requires an exact endpoint, unique configured client name, opaque ID, and typed media identity", async () => {
		const clients = factory([config], {
			records: [
				{
					downloadClient: "SAB local",
					downloadId: "opaque-queue-id",
					seriesId: 12,
					seriesTitle: "Synthetic Series",
				},
			],
		});
		const result = await correlateSabQueue(clients, "http://sab.local:8080", [job], [instance]);
		expect(clients.createSonarrClient).toHaveBeenCalledWith(instance, { timeout: 4000 });
		expect(result.get(job.nzoId)).toEqual({
			service: "sonarr",
			title: "Synthetic Series",
			instanceLabel: "TV library",
		});
		expect(JSON.stringify([...result])).not.toContain("must-not-escape");
	});

	it("leaves endpoint aliases, duplicate configurations, and missing media identity unresolved", async () => {
		const clients = factory([config, { ...config, id: 5 }], {
			records: [{ downloadClient: "SAB local", downloadId: "opaque-queue-id", seriesId: 12 }],
		});
		const result = await correlateSabQueue(
			clients,
			"http://sab-alias.local:8080",
			[job],
			[instance],
		);
		expect(result.size).toBe(0);
	});

	it("does not associate when the exact identity appears more than once", async () => {
		const clients = factory([config], {
			records: [
				{
					downloadClient: "SAB local",
					downloadId: "opaque-queue-id",
					seriesId: 12,
					seriesTitle: "One",
				},
				{
					downloadClient: "SAB local",
					downloadId: "opaque-queue-id",
					seriesId: 13,
					seriesTitle: "Two",
				},
			],
		});
		const result = await correlateSabQueue(clients, "http://sab.local:8080", [job], [instance]);
		expect(result.size).toBe(0);
	});
});
