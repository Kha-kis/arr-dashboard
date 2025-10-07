/** @type {import('next').NextConfig} */
const nextConfig = {
	eslint: {
		dirs: ["app", "src"],
	},
	poweredByHeader: false,
	async headers() {
		const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
		// Extract the origin (protocol + host) for CSP
		const apiOrigin = new URL(apiUrl).origin;

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
							`connect-src 'self' ${apiOrigin}`,
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
