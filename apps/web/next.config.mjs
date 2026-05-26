/** @type {import('next').NextConfig} */

// Allow HMR from non-localhost origins in development (e.g., WSL2 IP).
// Set DEV_ALLOWED_ORIGINS in .env.local: DEV_ALLOWED_ORIGINS=172.x.x.x
// In dev we ALSO accept the active WSL2 IP via `os.networkInterfaces()`
// so the white-screen-on-cross-origin failure mode doesn't bite operators
// who access the dev server via the LAN IP instead of localhost.
import os from "node:os";

function wslAndLocalDevOrigins() {
	const fromEnv = process.env.DEV_ALLOWED_ORIGINS
		? process.env.DEV_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
		: [];
	if (process.env.NODE_ENV === "production") return fromEnv;
	const ipv4 = Object.values(os.networkInterfaces())
		.flat()
		.filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
		.map((iface) => iface.address);
	return [...new Set([...fromEnv, "localhost", "127.0.0.1", ...ipv4])];
}

const allowedOrigins = wslAndLocalDevOrigins();

const nextConfig = {
	output: "standalone",
	...(allowedOrigins.length > 0 && { allowedDevOrigins: allowedOrigins }),
	// Empty turbopack config to silence Next.js 16 warning when using --webpack for builds
	turbopack: {},
	poweredByHeader: false,
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "image.tmdb.org",
				pathname: "/t/p/**",
			},
		],
	},
	async rewrites() {
		const apiHost = process.env.API_HOST || "http://localhost:3001";
		return [
			{
				source: "/api/:path*",
				destination: `${apiHost}/api/:path*`,
			},
			{
				source: "/auth/:path*",
				destination: `${apiHost}/auth/:path*`,
			},
		];
	},
	async headers() {
		const isDev = process.env.NODE_ENV !== "production";

		// In development, allow direct API connections for HMR/WebSocket
		// In production, API is proxied through Next.js rewrites — only 'self' needed
		const connectSrc = isDev
			? "connect-src 'self' http://localhost:3001 ws://localhost:3001 wss://localhost:3001 http://127.0.0.1:3001 ws://127.0.0.1:3001"
			: "connect-src 'self'";

		// unsafe-eval is needed for HMR in development but not in production
		const scriptSrc = isDev
			? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
			: "script-src 'self' 'unsafe-inline'";

		return [
			{
				source: "/:path*",
				headers: [
					{
						key: "Content-Security-Policy",
						value: [
							"default-src 'self'",
							scriptSrc,
							"style-src 'self' 'unsafe-inline'",
							"img-src 'self' data: https:",
							"font-src 'self' data:",
							connectSrc,
							"frame-ancestors 'none'",
						].join("; "),
					},
					{
						key: "X-Frame-Options",
						value: "DENY",
					},
					{
						key: "X-Content-Type-Options",
						value: "nosniff",
					},
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
					{
						key: "Permissions-Policy",
						value: "camera=(), microphone=(), geolocation=()",
					},
				],
			},
		];
	},
};

export default nextConfig;
