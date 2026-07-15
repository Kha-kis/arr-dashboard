import { z } from "zod";

export const setupDiscoveryProtocolSchema = z.enum([
	"plex-gdm",
	"plex-ssdp",
	"jellyfin-udp",
	"emby-udp",
]);
export type SetupDiscoveryProtocol = z.infer<typeof setupDiscoveryProtocolSchema>;

function isCredentialFreeHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return (
			["http:", "https:"].includes(parsed.protocol) &&
			!parsed.username &&
			!parsed.password &&
			!parsed.search &&
			!parsed.hash
		);
	} catch {
		return false;
	}
}

export const setupDiscoveryCandidateSchema = z.object({
	service: z.enum(["plex", "jellyfin", "emby"]),
	name: z.string().min(1).max(120),
	baseUrl: z.string().max(2048).url().refine(isCredentialFreeHttpUrl, {
		message: "Discovery candidates must use credential-free HTTP or HTTPS URLs",
	}),
	serverId: z.string().min(1).max(256).nullable(),
	protocol: setupDiscoveryProtocolSchema,
});
export type SetupDiscoveryCandidate = z.infer<typeof setupDiscoveryCandidateSchema>;

export const setupDiscoveryResponseSchema = z.object({
	candidates: z.array(setupDiscoveryCandidateSchema),
	scannedProtocols: z.array(setupDiscoveryProtocolSchema),
	durationMs: z.number().int().nonnegative(),
});
export type SetupDiscoveryResponse = z.infer<typeof setupDiscoveryResponseSchema>;
