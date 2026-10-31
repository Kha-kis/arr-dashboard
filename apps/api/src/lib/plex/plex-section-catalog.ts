import type { PlexEvidenceSummary, PlexSectionsResponse } from "@arr/shared";
import type { ServiceInstance } from "../prisma.js";
import { evaluateProviderDomainCoverageMap } from "../provider-observation/coverage-receipt.js";
import {
	createProviderPublicationAuthority,
	sameProviderPublicationAuthority,
} from "../services/provider-identity-guard.js";
import {
	loadGenerationObservationsForOwnedInstances,
	summarizePlexEvidence,
} from "./plex-evidence-repository.js";
import type { DecodedPlexGenerationMetadata } from "./plex-generation-metadata.js";

type CatalogPrisma = Parameters<typeof loadGenerationObservationsForOwnedInstances>[0];
type CatalogResponse = Required<Pick<PlexSectionsResponse, "sections" | "catalog">> & {
	evidence: PlexEvidenceSummary;
};
type CatalogResult =
	| { available: true; response: CatalogResponse; instances: ServiceInstance[] }
	| { available: false; response: Omit<CatalogResponse, "sections"> };

function provedSections(metadata: DecodedPlexGenerationMetadata) {
	if (metadata.version !== 5 && metadata.version !== 6) return null;
	if (new Set(metadata.sections.map((section) => section.uuid)).size !== metadata.sections.length)
		return null;
	if (metadata.version === 5 && metadata.publicationLevel === "authoritative") {
		const scopes = new Set(metadata.coverageReceipt.units.map((unit) => unit.scopeKey));
		if (
			scopes.size !== metadata.sections.length ||
			!metadata.sections.every((section) => scopes.has(`section:${section.key}`))
		)
			return null;
		return metadata.sections;
	}
	if (metadata.version !== 6) return null;
	const coverage = evaluateProviderDomainCoverageMap(metadata.coverageReceipt).get(
		"library-inventory",
	);
	if (
		coverage?.availability !== "current" ||
		coverage.evidence !== "complete" ||
		coverage.valueSemantics !== "exact"
	)
		return null;
	const inventory = metadata.coverageReceipt.domains.find(
		(domain) => domain.domain === "library-inventory",
	);
	const scopes = new Set(inventory?.units.map((unit) => unit.scopeKey));
	if (
		scopes.size !== metadata.sections.length ||
		!metadata.sections.every((section) => scopes.has(`section:${section.key}:inventory`))
	)
		return null;
	return metadata.sections;
}

/** Cache-only catalog display. Its status never grants canonical/watch mutation authority. */
export async function loadPlexSectionCatalog(
	prisma: CatalogPrisma,
	input: { userId: string; instanceId?: string; now?: Date; maxAgeMs?: number },
): Promise<CatalogResult> {
	let evidence = summarizePlexEvidence([]);
	const unavailable = (): CatalogResult => ({
		available: false,
		response: { evidence, catalog: { availability: "unavailable", observedAt: null } },
	});
	try {
		const where = {
			userId: input.userId,
			service: "PLEX" as const,
			enabled: true,
			...(input.instanceId ? { id: input.instanceId } : {}),
		};
		const instances = (
			await prisma.serviceInstance.findMany({ where, orderBy: { id: "asc" } })
		).map((instance) => ({ ...instance }));
		if (instances.length === 0) return unavailable();
		const observations = await loadGenerationObservationsForOwnedInstances(prisma, {
			...input,
			instances,
		});
		evidence = summarizePlexEvidence(observations);
		const sections: PlexSectionsResponse["sections"] = [];
		let availability: "current" | "last-known" = "current";
		let observedAt: number | null = null;
		for (const entry of observations) {
			if (!entry.available) return unavailable();
			const catalogSections = provedSections(entry.metadata);
			if (!catalogSections) return unavailable();
			if (entry.evidence.availability !== "current") availability = "last-known";
			observedAt = Math.min(observedAt ?? entry.publishedAt.getTime(), entry.publishedAt.getTime());
			for (const section of catalogSections) {
				sections.push({
					sectionId: section.key,
					sectionUuid: section.uuid,
					sectionTitle: section.title,
					mediaType: section.type === "show" ? "series" : "movie",
					instanceId: entry.instanceId,
					instanceName: entry.instanceName,
				});
			}
		}
		// Do not expose a catalog from a connection that changed during its reads.
		const current = await prisma.serviceInstance.findMany({ where, orderBy: { id: "asc" } });
		const currentById = new Map(current.map((instance) => [instance.id, instance]));
		if (
			current.length !== instances.length ||
			instances.some((instance) => {
				const after = currentById.get(instance.id);
				return (
					!after ||
					!sameProviderPublicationAuthority(
						createProviderPublicationAuthority(instance),
						createProviderPublicationAuthority(after),
					)
				);
			})
		)
			return unavailable();
		return {
			available: true,
			instances,
			response: {
				sections,
				evidence,
				catalog: {
					availability,
					observedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
				},
			},
		};
	} catch {
		return unavailable();
	}
}
