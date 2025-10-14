"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { startAuthentication } from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUser, useSetupRequired, useLoginMutation } from "../../../hooks/api/useAuth";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { Alert, AlertDescription } from "../../../components/ui";
import {
	getOIDCProviders,
	initiateOIDCLogin,
	getPasskeyLoginOptions,
	verifyPasskeyLogin,
	type OIDCProvider,
} from "../../../lib/api-client/auth";

const DEFAULT_REDIRECT = "/dashboard";

const sanitizeRedirect = (value: string | null): string => {
	if (!value) {
		return DEFAULT_REDIRECT;
	}
	if (!value.startsWith("/")) {
		return DEFAULT_REDIRECT;
	}
	try {
		const url = new URL(value, "http://localhost");
		return `${url.pathname}${url.search}`;
	} catch (_error) {
		return DEFAULT_REDIRECT;
	}
};

const providerDisplayNames: Record<string, string> = {
	authelia: "Authelia",
	authentik: "Authentik",
	generic: "OIDC Provider",
};

export const LoginForm = () => {
	const router = useRouter();
	const searchParams = useSearchParams();
	const queryClient = useQueryClient();
	const loginMutation = useLoginMutation();
	const { data: setupRequired, isLoading: setupLoading } = useSetupRequired();

	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [rememberMe, setRememberMe] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// OIDC and Passkey state
	const [oidcProviders, setOIDCProviders] = useState<OIDCProvider[]>([]);
	const [oidcLoading, setOIDCLoading] = useState(false);
	const [passkeyLoading, setPasskeyLoading] = useState(false);

	const redirectTarget = useMemo(
		() => sanitizeRedirect(searchParams?.get("redirectTo") ?? null),
		[searchParams],
	);

	// Load available OIDC providers
	useEffect(() => {
		const loadProviders = async () => {
			try {
				const providers = await getOIDCProviders();
				setOIDCProviders(providers);
			} catch (error) {
				// Silently fail - OIDC not configured
			}
		};
		loadProviders();
	}, []);

	// Redirect to setup if no users exist
	useEffect(() => {
		if (!setupLoading && setupRequired === true) {
			router.replace("/setup");
		}
	}, [setupLoading, setupRequired, router]);

	const handlePasswordLogin = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setErrorMessage(null);

		const trimmedUsername = username.trim();
		if (trimmedUsername.length === 0) {
			setErrorMessage("Please enter your username.");
			return;
		}

		try {
			await loginMutation.mutateAsync({
				username: trimmedUsername,
				password,
				rememberMe,
			});
			setPassword("");
			// Use full page navigation to ensure cookie is sent
			window.location.href = redirectTarget;
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Unable to sign in. Please verify your credentials and try again.";
			setErrorMessage(message);
		}
	};

	const handleOIDCLogin = async (provider: string) => {
		setErrorMessage(null);
		setOIDCLoading(true);

		try {
			const authUrl = await initiateOIDCLogin(provider as any);
			// Redirect to OIDC provider
			window.location.href = authUrl;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to initiate OIDC login";
			setErrorMessage(message);
			setOIDCLoading(false);
		}
	};

	const handlePasskeyLogin = async () => {
		setErrorMessage(null);
		setPasskeyLoading(true);

		try {
			// Get authentication options from server
			const { options, sessionId } = await getPasskeyLoginOptions();

			// Start WebAuthn authentication
			const authResponse = await startAuthentication({ optionsJSON: options });

			// Verify authentication with server
			await verifyPasskeyLogin(authResponse, sessionId);

			// Invalidate queries to update authentication state
			await queryClient.invalidateQueries({ queryKey: ["user"] });

			// Use full page navigation to ensure cookie is sent
			window.location.href = redirectTarget;
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Passkey authentication failed. Please try again or use password.";
			setErrorMessage(message);
			setPasskeyLoading(false);
		}
	};

	const disabled = loginMutation.isPending || oidcLoading || passkeyLoading;
	const hasAlternativeMethods = oidcProviders.length > 0 || true; // Passkey always available

	// Show loading while checking setup requirement
	if (setupLoading) {
		return (
			<div className="flex min-h-[60vh] flex-col items-center justify-center">
				<div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white" />
			</div>
		);
	}

	// Don't render if setup is required (will redirect)
	if (setupRequired === true) {
		return null;
	}

	return (
		<div className="flex min-h-[60vh] flex-col items-center justify-center gap-6">
			<div className="text-center">
				<p className="text-sm uppercase tracking-[0.3em] text-white/50">Arr Control Center</p>
				<h1 className="mt-2 text-3xl font-semibold text-white">Sign in to your dashboard</h1>
				<p className="mt-2 text-sm text-white/60">
					{hasAlternativeMethods
						? "Choose your preferred authentication method."
						: "Use your admin credentials to continue."}
				</p>
			</div>

			<Card className="w-full max-w-sm border-white/10 bg-white/5">
				<CardHeader>
					<CardTitle className="text-xl text-white">Welcome back</CardTitle>
					<CardDescription className="text-white/60">
						Sign in to manage your Sonarr, Radarr, and Prowlarr instances.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Passkey Login */}
					<div className="space-y-3">
						<Button
							type="button"
							variant="secondary"
							className="w-full border-white/20 bg-white/5 text-white hover:bg-white/10"
							onClick={handlePasskeyLogin}
							disabled={disabled}
						>
							{passkeyLoading ? (
								<>
									<div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white" />
									Authenticating with passkey...
								</>
							) : (
								<>
									<svg
										className="mr-2 h-4 w-4"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={2}
											d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
										/>
									</svg>
									Sign in with passkey
								</>
							)}
						</Button>
					</div>

					{/* OIDC Providers */}
					{oidcProviders.length > 0 && (
						<div className="space-y-3">
							{oidcProviders.map((provider) => (
								<Button
									key={provider.type}
									type="button"
									variant="secondary"
									className="w-full border-white/20 bg-white/5 text-white hover:bg-white/10"
									onClick={() => handleOIDCLogin(provider.type)}
									disabled={disabled}
								>
									{oidcLoading ? (
										<>
											<div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white" />
											Redirecting...
										</>
									) : (
										<>
											<svg
												className="mr-2 h-4 w-4"
												fill="none"
												stroke="currentColor"
												viewBox="0 0 24 24"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M13 10V3L4 14h7v7l9-11h-7z"
												/>
											</svg>
											Sign in with {provider.displayName || providerDisplayNames[provider.type] || provider.type}
										</>
									)}
								</Button>
							))}
						</div>
					)}

					{/* Divider */}
					{hasAlternativeMethods && (
						<div className="relative">
							<div className="absolute inset-0 flex items-center">
								<div className="w-full border-t border-white/10" />
							</div>
							<div className="relative flex justify-center text-xs uppercase">
								<span className="bg-[#0a0a0a] px-2 text-white/40">Or continue with</span>
							</div>
						</div>
					)}

					{/* Password Login Form */}
					<form className="space-y-5" onSubmit={handlePasswordLogin} autoComplete="off">
						<div className="space-y-2">
							<label
								htmlFor="username"
								className="block text-xs font-semibold uppercase tracking-wide text-white/60"
							>
								Username
							</label>
							<Input
								id="username"
								name="username"
								value={username}
								onChange={(event) => setUsername(event.target.value)}
								placeholder="Enter your username"
								autoComplete="off"
								required
								disabled={disabled}
							/>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="password"
								className="block text-xs font-semibold uppercase tracking-wide text-white/60"
							>
								Password
							</label>
							<Input
								id="password"
								name="password"
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								placeholder="Enter your password"
								autoComplete="off"
								required
								disabled={disabled}
							/>
						</div>

						<div className="flex items-center gap-2">
							<input
								type="checkbox"
								id="rememberMe"
								name="rememberMe"
								checked={rememberMe}
								onChange={(e) => setRememberMe(e.target.checked)}
								className="h-4 w-4 rounded border-white/20 bg-white/5 text-primary focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-bg"
								disabled={disabled}
							/>
							<label htmlFor="rememberMe" className="text-sm text-white/70 cursor-pointer">
								Remember me for 30 days
							</label>
						</div>

						{errorMessage && (
							<Alert variant="danger">
								<AlertDescription>{errorMessage}</AlertDescription>
							</Alert>
						)}

						<Button className="w-full" type="submit" disabled={disabled}>
							{loginMutation.isPending ? "Signing in..." : "Sign in with password"}
						</Button>
					</form>
				</CardContent>
			</Card>

			<p className="text-xs text-white/40">
				Need to configure services? Head over to{" "}
				<Link href="/settings" className="text-white/70 underline hover:text-white">
					Settings
				</Link>{" "}
				after signing in.
			</p>
		</div>
	);
};
