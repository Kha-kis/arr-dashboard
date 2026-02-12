import { webcrypto } from "node:crypto";
import {
	type AuthenticationResponseJSON,
	type AuthenticatorTransportFuture,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
	type VerifiedRegistrationResponse,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { FastifyInstance } from "fastify";

/**
 * Verify that a crypto implementation has the required Web Crypto API methods.
 * @simplewebauthn/server requires getRandomValues() and crypto.subtle for cryptographic operations.
 */
function hasRequiredCryptoMethods(cryptoImpl: unknown): cryptoImpl is Crypto {
	if (!cryptoImpl || typeof cryptoImpl !== "object") {
		return false;
	}

	const crypto = cryptoImpl as Record<string, unknown>;

	// Check for getRandomValues method (required for random value generation)
	if (typeof crypto.getRandomValues !== "function") {
		return false;
	}

	// Check for subtle property (required for cryptographic operations)
	if (!crypto.subtle || typeof crypto.subtle !== "object") {
		return false;
	}

	// Verify subtle has required methods (at minimum, we need encrypt/decrypt/sign/verify)
	const subtle = crypto.subtle as Record<string, unknown>;
	const requiredMethods = ["encrypt", "decrypt", "sign", "verify", "generateKey"];
	for (const method of requiredMethods) {
		if (typeof subtle[method] !== "function") {
			return false;
		}
	}

	return true;
}

/**
 * Polyfill WebCrypto for Node.js < 19
 *
 * Safely checks for existing crypto implementation and verifies compatibility
 * before using webcrypto as a fallback. This prevents runtime errors from
 * incomplete or incompatible crypto implementations.
 */
if (!hasRequiredCryptoMethods(globalThis.crypto)) {
	// Verify webcrypto has required methods before using as fallback
	if (hasRequiredCryptoMethods(webcrypto)) {
		globalThis.crypto = webcrypto as typeof globalThis.crypto;
	} else {
		// This should not happen on Node.js 15+ where webcrypto is available
		// But we provide a clear error message if it does
		throw new Error(
			"Web Crypto API is not available. This application requires Node.js 15+ with Web Crypto API support. " +
				"Please upgrade to Node.js 19+ for native support, or ensure webcrypto is available in your Node.js version.",
		);
	}
}

/**
 * WebAuthn Relying Party configuration
 */
export interface PasskeyServiceConfig {
	rpName: string; // Relying Party name (e.g., "Arr Dashboard")
	rpID: string; // Relying Party ID (e.g., "arr-dashboard.example.com" or "localhost")
	origin: string; // Expected origin (e.g., "https://arr-dashboard.example.com" or "http://localhost:3000")
}

/**
 * Passkey service for WebAuthn registration and authentication
 */
export class PasskeyService {
	private config: PasskeyServiceConfig;
	private app: FastifyInstance;

	constructor(app: FastifyInstance, config: PasskeyServiceConfig) {
		this.app = app;
		this.config = config;
	}

	/**
	 * Generate registration options for a new passkey
	 */
	async generateRegistrationOptions(
		userId: string,
		username: string,
		userEmail?: string,
	): Promise<PublicKeyCredentialCreationOptionsJSON> {
		// Get existing credentials for this user to exclude them
		const existingCredentials = await this.app.prisma.webAuthnCredential.findMany({
			where: { userId },
			select: { id: true },
		});

		const options = await generateRegistrationOptions({
			rpName: this.config.rpName,
			rpID: this.config.rpID,
			userID: Buffer.from(userId, "utf-8"), // Convert string to Buffer for @simplewebauthn/server v13+
			userName: username,
			userDisplayName: userEmail ?? username, // Use username if email not provided
			// Exclude existing credentials to prevent re-registering the same authenticator
			excludeCredentials: existingCredentials.map((cred) => ({
				id: cred.id,
				type: "public-key",
				transports: ["usb", "nfc", "ble", "internal"] as AuthenticatorTransportFuture[],
			})),
			authenticatorSelection: {
				// Allow both platform (Touch ID, Windows Hello) and roaming (YubiKey, USB) authenticators
				// authenticatorAttachment removed to support cross-platform authenticators
				// Require user verification (biometrics, PIN, etc.)
				userVerification: "required",
				// Allow credentials to be discovered (resident keys)
				residentKey: "required",
			},
			// Support both discoverable and non-discoverable credentials
			attestationType: "none",
		});

		return options;
	}

	/**
	 * Verify registration response and store credential
	 */
	async verifyRegistration(
		userId: string,
		response: RegistrationResponseJSON,
		expectedChallenge: string,
		friendlyName?: string,
	): Promise<VerifiedRegistrationResponse> {
		const verification = await verifyRegistrationResponse({
			response,
			expectedChallenge,
			expectedOrigin: this.config.origin,
			expectedRPID: this.config.rpID,
		});

		if (!verification.verified || !verification.registrationInfo) {
			throw new Error("Passkey registration verification failed");
		}

		// @simplewebauthn/server v13+ changed the structure - credentials are now under 'credential' object
		const { credential, credentialBackedUp } = verification.registrationInfo;

		// Use response.id which is already base64url encoded and matches what the browser sends during auth
		// This avoids double-encoding issues with credential.id
		const credentialId = response.id;

		// Store credential in database
		await this.app.prisma.webAuthnCredential.create({
			data: {
				id: credentialId, // Already base64url from browser
				userId,
				publicKey: isoBase64URL.fromBuffer(credential.publicKey),
				counter: credential.counter,
				transports: response.response.transports
					? JSON.stringify(response.response.transports)
					: null,
				backedUp: credentialBackedUp,
				friendlyName: friendlyName ?? "Passkey",
			},
		});

		return verification;
	}

	/**
	 * Generate authentication options for passkey login
	 */
	async generateAuthenticationOptions(
		userId?: string,
	): Promise<PublicKeyCredentialRequestOptionsJSON> {
		// If userId provided, get their credentials
		// Otherwise, allow any credential (discoverable credentials)
		const allowCredentials = userId
			? await this.app.prisma.webAuthnCredential.findMany({
					where: { userId },
					select: { id: true, transports: true },
				})
			: [];

		const options = await generateAuthenticationOptions({
			rpID: this.config.rpID,
			// If user-specific, limit to their credentials
			allowCredentials: allowCredentials.map((cred) => {
				let transports: AuthenticatorTransportFuture[] | undefined;
				if (cred.transports) {
					try {
						transports = JSON.parse(cred.transports) as AuthenticatorTransportFuture[];
					} catch {
						// Skip invalid transport data, use undefined
						transports = undefined;
					}
				}
				return {
					id: cred.id,
					type: "public-key",
					transports,
				};
			}),
			userVerification: "required",
		});

		return options;
	}

	/**
	 * Verify authentication response
	 */
	async verifyAuthentication(
		response: AuthenticationResponseJSON,
		expectedChallenge: string,
	): Promise<{ verified: boolean; userId: string; credentialId: string }> {
		// Get credential from database
		const credentialId = response.id;
		const credential = await this.app.prisma.webAuthnCredential.findUnique({
			where: { id: credentialId },
		});

		if (!credential) {
			throw new Error("Passkey credential not found");
		}

		// v13+ renamed 'authenticator' parameter to 'credential'
		const verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge,
			expectedOrigin: this.config.origin,
			expectedRPID: this.config.rpID,
			credential: {
				id: credential.id,
				publicKey: isoBase64URL.toBuffer(credential.publicKey),
				counter: credential.counter,
			},
		});

		if (!verification.verified) {
			throw new Error("Passkey authentication verification failed");
		}

		// Update counter to prevent replay attacks
		await this.app.prisma.webAuthnCredential.update({
			where: { id: credentialId },
			data: {
				counter: verification.authenticationInfo.newCounter,
				lastUsedAt: new Date(),
			},
		});

		return {
			verified: true,
			userId: credential.userId,
			credentialId: credential.id,
		};
	}

	/**
	 * List user's registered passkeys
	 */
	async listUserCredentials(userId: string) {
		return this.app.prisma.webAuthnCredential.findMany({
			where: { userId },
			select: {
				id: true,
				friendlyName: true,
				backedUp: true,
				createdAt: true,
				lastUsedAt: true,
			},
			orderBy: { lastUsedAt: "desc" },
		});
	}

	/**
	 * Delete a passkey credential
	 */
	async deleteCredential(userId: string, credentialId: string): Promise<boolean> {
		const result = await this.app.prisma.webAuthnCredential.deleteMany({
			where: {
				id: credentialId,
				userId, // Ensure user can only delete their own credentials
			},
		});

		return result.count > 0;
	}

	/**
	 * Rename a passkey credential
	 */
	async renameCredential(
		userId: string,
		credentialId: string,
		friendlyName: string,
	): Promise<boolean> {
		const result = await this.app.prisma.webAuthnCredential.updateMany({
			where: {
				id: credentialId,
				userId,
			},
			data: { friendlyName },
		});

		return result.count > 0;
	}
}

/**
 * Create passkey service from environment configuration
 */
export function createPasskeyService(app: FastifyInstance): PasskeyService {
	const rpName = process.env.WEBAUTHN_RP_NAME ?? "Arr Dashboard";
	const rpID = process.env.WEBAUTHN_RP_ID ?? "localhost";
	const origin = process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3000";

	return new PasskeyService(app, {
		rpName,
		rpID,
		origin,
	});
}
