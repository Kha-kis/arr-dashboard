import { z } from "zod";

export const credentialFreeUrlSchema = z
	.string()
	.url()
	.refine((value) => {
		try {
			const url = new URL(value);
			return !url.username && !url.password;
		} catch {
			return false;
		}
	}, "URL must not include credentials; use the HTTP Basic Auth fields instead");

export const httpAuthSchema = z.object({
	username: z
		.string()
		.min(1)
		.max(256)
		.refine((value) => !value.includes(":"), {
			message: "HTTP Basic Auth username must not contain a colon",
		}),
	password: z.string().min(1).max(1024),
});

export function getHttpAuthConflict(service: string): string | null {
	if (service === "jellyfin") {
		return "Modern Jellyfin authentication already uses the Authorization header.";
	}
	return null;
}
