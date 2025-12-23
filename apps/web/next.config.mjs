/** @type {import('next').NextConfig} */

const nextConfig = {
	output: "standalone",
	eslint: {
		dirs: ["app", "src"],
	},
	poweredByHeader: false,
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
		return [
			{
				source: "/:path*",
				headers: [
					{
						key: "Content-Security-Policy",
						value: [
							"default-src 'self'",
							"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
							"style-src 'self' 'unsafe-inline'",
							"img-src 'self' data: https:",
							"font-src 'self' data:",
							// Allow WebSocket and HTTP connections to API in development
							"connect-src 'self' http://localhost:3001 ws://localhost:3001 wss://localhost:3001 http://127.0.0.1:3001 ws://127.0.0.1:3001",
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
