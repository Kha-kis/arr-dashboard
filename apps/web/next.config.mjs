/** @type {import('next').NextConfig} */

// URL Base for reverse proxy subpath support (e.g., "/arr-dashboard")
// Must NOT have trailing slash, empty string if not used
const basePath = process.env.BASE_PATH || "";

const nextConfig = {
	output: "standalone",
	// Enable subpath routing for reverse proxy support
	...(basePath && { basePath }),
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
							"connect-src 'self'",
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
