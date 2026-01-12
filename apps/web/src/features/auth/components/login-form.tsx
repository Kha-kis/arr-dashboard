"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { startAuthentication } from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Zap, Lock, Loader2 } from "lucide-react";
import { useCurrentUser, useSetupRequired, useLoginMutation } from "../../../hooks/api/useAuth";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { PasswordInput } from "../../../components/ui/password-input";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { Alert, AlertDescription } from "../../../components/ui";
import {
	getOIDCProvider,
	initiateOIDCLogin,
	getPasskeyLoginOptions,
	verifyPasskeyLogin,
} from "../../../lib/api-client/auth";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

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

export const LoginForm = () => {
	const { gradient: themeGradient } = useThemeGradient();

	const router = useRouter();
	const searchParams = useSearchParams();
	const queryClient = useQueryClient();
	const loginMutation = useLoginMutation();
	const { data: setupRequired, isLoading: setupLoading, error: setupError } = useSetupRequired();

	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [rememberMe, setRememberMe] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// OIDC and Passkey state
	const [oidcProvider, setOIDCProvider] = useState<{ displayName: string; enabled: boolean } | null>(null);
	const [oidcLoading, setOIDCLoading] = useState(false);
	const [passkeyLoading, setPasskeyLoading] = useState(false);

	const redirectTarget = useMemo(
		() => sanitizeRedirect(searchParams?.get("redirectTo") ?? null),
		[searchParams],
	);

	// Load OIDC provider (if configured)
	useEffect(() => {
		const loadProvider = async () => {
			try {
				const provider = await getOIDCProvider();
				setOIDCProvider(provider);
			} catch (error) {
				// Silently fail - OIDC not configured
			}
		};
		loadProvider();
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

	const handleOIDCLogin = async () => {
		setErrorMessage(null);
		setOIDCLoading(true);

		try {
			const authUrl = await initiateOIDCLogin();
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
	// Passkey is always available, so there is always at least one alternative method.
	const hasAlternativeMethods = true;

	// Show loading while checking setup requirement
	if (setupLoading) {
		return (
			<div className="flex min-h-[60vh] flex-col items-center justify-center">
				<div
					className="h-10 w-10 animate-spin rounded-full border-4 border-t-transparent"
					style={{ borderColor: `${themeGradient.from}30`, borderTopColor: 'transparent' }}
				/>
			</div>
		);
	}

	// Show API connection error
	if (setupError) {
		const isNetworkError = setupError.name === "NetworkError";
		return (
			<div className="flex min-h-[60vh] flex-col items-center justify-center gap-6">
				<div className="text-center">
					<p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">Arr Control Center</p>
					<h1 className="mt-2 text-3xl font-semibold text-foreground">Connection Error</h1>
				</div>

				<Card
					className="w-full max-w-md border-border/50 bg-card/80 backdrop-blur-sm"
					style={{
						borderColor: SEMANTIC_COLORS.error.border,
						backgroundColor: SEMANTIC_COLORS.error.bg,
					}}
				>
					<CardHeader>
						<CardTitle
							className="flex items-center gap-2 text-xl"
							style={{ color: SEMANTIC_COLORS.error.from }}
						>
							<svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
							</svg>
							{isNetworkError ? "Cannot Connect to API" : "Server Error"}
						</CardTitle>
						<CardDescription className="text-muted-foreground">
							{isNetworkError
								? "The dashboard cannot reach the API server. This usually means:"
								: "An unexpected error occurred while connecting to the server."}
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						{isNetworkError && (
							<ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
								<li>The API server is not running or starting up</li>
								<li>The API port configuration is incorrect</li>
								<li>A firewall or network issue is blocking the connection</li>
							</ul>
						)}
						<div className="rounded-lg bg-muted/50 p-3 font-mono text-xs text-muted-foreground">
							{setupError.message}
						</div>
						<Button
							variant="outline"
							className="w-full rounded-xl"
							onClick={() => window.location.reload()}
						>
							<svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
							</svg>
							Retry Connection
						</Button>
					</CardContent>
				</Card>
			</div>
		);
	}

	// Don't render if setup is required (will redirect)
	if (setupRequired === true) {
		return null;
	}

	return (
		<div className="flex min-h-[60vh] flex-col items-center justify-center gap-6">
			{/* Header */}
			<div className="text-center">
				<p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">Arr Control Center</p>
				<h1
					className="mt-2 text-3xl font-bold tracking-tight"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					Sign in to your dashboard
				</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					{hasAlternativeMethods
						? "Choose your preferred authentication method."
						: "Use your admin credentials to continue."}
				</p>
			</div>

			{/* Login Card */}
			<Card className="w-full max-w-sm border-border/50 bg-card/80 backdrop-blur-sm">
				<CardHeader>
					<CardTitle className="text-xl text-foreground">Welcome back</CardTitle>
					<CardDescription className="text-muted-foreground">
						Sign in to manage your Sonarr, Radarr, and Prowlarr instances.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Passkey Login */}
					<div className="space-y-3">
						<Button
							type="button"
							variant="outline"
							className="w-full rounded-xl gap-2"
							onClick={handlePasskeyLogin}
							disabled={disabled}
						>
							{passkeyLoading ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Authenticating with passkey...
								</>
							) : (
								<>
									<KeyRound className="h-4 w-4" />
									Sign in with passkey
								</>
							)}
						</Button>
					</div>

					{/* OIDC Provider */}
					{oidcProvider && oidcProvider.enabled && (
						<div className="space-y-3">
							<Button
								type="button"
								variant="outline"
								className="w-full rounded-xl gap-2"
								onClick={handleOIDCLogin}
								disabled={disabled}
							>
								{oidcLoading ? (
									<>
										<Loader2 className="h-4 w-4 animate-spin" />
										Redirecting...
									</>
								) : (
									<>
										<Zap className="h-4 w-4" />
										Sign in with {oidcProvider.displayName}
									</>
								)}
							</Button>
						</div>
					)}

					{/* Divider */}
					{hasAlternativeMethods && (
						<div className="relative">
							<div className="absolute inset-0 flex items-center">
								<div className="w-full border-t border-border/50" />
							</div>
							<div className="relative flex justify-center text-xs uppercase">
								<span className="bg-card px-2 text-muted-foreground">Or continue with</span>
							</div>
						</div>
					)}

					{/* Password Login Form */}
					<form className="space-y-5" onSubmit={handlePasswordLogin} autoComplete="off">
						<div className="space-y-2">
							<label
								htmlFor="username"
								className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground"
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
								className="rounded-xl"
							/>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="password"
								className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground"
							>
								Password
							</label>
							<PasswordInput
								id="password"
								name="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								placeholder="Enter your password"
								autoComplete="off"
								required
								disabled={disabled}
								className="rounded-xl"
							/>
						</div>

						<div className="flex items-center gap-2">
							<input
								type="checkbox"
								id="rememberMe"
								name="rememberMe"
								checked={rememberMe}
								onChange={(e) => setRememberMe(e.target.checked)}
								className="h-4 w-4 rounded border-border bg-background text-primary focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background"
								disabled={disabled}
							/>
							<label htmlFor="rememberMe" className="text-sm text-muted-foreground cursor-pointer">
								Remember me for 30 days
							</label>
						</div>

						{errorMessage && (
							<Alert variant="danger">
								<AlertDescription>{errorMessage}</AlertDescription>
							</Alert>
						)}

						<Button
							className="w-full gap-2 rounded-xl font-medium"
							type="submit"
							disabled={disabled}
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
							}}
						>
							{loginMutation.isPending ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Signing in...
								</>
							) : (
								<>
									<Lock className="h-4 w-4" />
									Sign in with password
								</>
							)}
						</Button>
					</form>
				</CardContent>
			</Card>

			<p className="text-xs text-muted-foreground">
				Need to configure services? Head over to{" "}
				<Link
					href="/settings"
					className="font-medium underline transition-colors hover:text-foreground"
					style={{ color: themeGradient.from }}
				>
					Settings
				</Link>{" "}
				after signing in.
			</p>
		</div>
	);
};
