# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Arr Dashboard, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please use one of the following methods:

1. **GitHub Security Advisories** (preferred): [Report a vulnerability](https://github.com/Kha-kis/arr-dashboard/security/advisories/new)
2. **Email**: Open a private security advisory on GitHub

## What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix**: Depends on severity (critical: ASAP, high: within 1 week, medium/low: next release)

## Scope

The following are in scope:

- Authentication bypass (password, OIDC, passkeys)
- Session management vulnerabilities
- API key encryption/decryption
- Cross-site scripting (XSS)
- Cross-site request forgery (CSRF)
- SQL injection / Prisma query injection
- Server-side request forgery (SSRF)
- Privilege escalation
- Information disclosure (API keys, credentials)

The following are out of scope:

- Denial of service (self-hosted, single-admin app)
- Issues requiring physical access to the host
- Vulnerabilities in dependencies without a demonstrated exploit path
- Social engineering

## Security Architecture

- **Encryption**: AES-256-GCM for API keys at rest
- **Password hashing**: Argon2id (19 MiB memory, 2 iterations)
- **Sessions**: 32-byte cryptographic tokens, SHA-256 hashed before storage
- **OIDC**: PKCE + state + nonce validation
- **Passkeys**: WebAuthn with counter-based replay protection
- **CSP**: Dynamic Content-Security-Policy (no `unsafe-eval` in production)

See [docs/AUTH.md](docs/AUTH.md) for detailed security architecture.
