# Multi-Authentication Setup Guide

Arr Dashboard supports multiple authentication methods:
- **Password Authentication** - Traditional username/password login (default, always enabled)
- **OIDC/OAuth2** - External authentication providers (Authelia, Authentik, or generic OIDC)
- **Passkeys (WebAuthn)** - Passwordless authentication using biometrics or security keys

## Table of Contents

- [Quick Start](#quick-start)
- [Password Authentication](#password-authentication)
- [Passkey Authentication](#passkey-authentication)
- [OIDC Authentication](#oidc-authentication)
  - [Authelia Setup](#authelia-setup)
  - [Authentik Setup](#authentik-setup)
  - [Generic OIDC Setup](#generic-oidc-setup)
- [Environment Variables Reference](#environment-variables-reference)
- [Security Considerations](#security-considerations)

---

## Quick Start

### Default Setup (Password Only)

No configuration needed. Create the first user on initial setup:

1. Navigate to `http://your-server:3000/setup`
2. Create an admin account with username and password
3. Log in with your credentials

### Adding Passkeys

Passkeys are always available once logged in:

1. Log in to your account
2. Go to **Settings** → **Account** tab
3. Scroll to **Passkeys** section
4. Click **Add Passkey** and follow your device's prompts
5. Next login, click **Sign in with passkey** button

---

## Password Authentication

Password authentication is the default method and cannot be disabled. It serves as a fallback if other methods fail.

### Password Requirements

- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character

### Account Lockout

- After 5 failed login attempts, the account is locked for 15 minutes
- Successful login resets failed attempt counter

---

## Passkey Authentication

Passkeys provide passwordless authentication using your device's biometrics (Touch ID, Face ID, Windows Hello) or hardware security keys (YubiKey).

### Requirements

- **HTTPS** required in production (localhost works over HTTP for development)
- Modern browser with WebAuthn support (Chrome, Firefox, Safari, Edge)
- Device with biometric authentication or external security key

### Environment Variables (WebAuthn)

```bash
# Required for passkey authentication
WEBAUTHN_RP_NAME="Arr Dashboard"                    # Relying Party name shown to users
WEBAUTHN_RP_ID="arr-dashboard.example.com"          # Your domain (no protocol, no port)
WEBAUTHN_ORIGIN="https://arr-dashboard.example.com" # Full URL with protocol
```

**Important:**
- `WEBAUTHN_RP_ID` must match your domain exactly (no `https://`, no port)
- `WEBAUTHN_ORIGIN` must include protocol and match where users access the dashboard
- For localhost development: `WEBAUTHN_RP_ID="localhost"` and `WEBAUTHN_ORIGIN="http://localhost:3000"`

### Docker Example

```yaml
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    environment:
      - WEBAUTHN_RP_NAME=Arr Dashboard
      - WEBAUTHN_RP_ID=arr.example.com
      - WEBAUTHN_ORIGIN=https://arr.example.com
```

### Passkey Management

Users can manage their passkeys in **Settings** → **Account**:
- Register multiple passkeys (e.g., iPhone, laptop, YubiKey)
- Rename passkeys for easy identification
- Delete passkeys they no longer use
- View last used date and backup status

---

## OIDC Authentication

OIDC (OpenID Connect) allows users to authenticate using external identity providers.

### Supported Providers

1. **Authelia** - Self-hosted authentication server
2. **Authentik** - Open-source identity provider
3. **Generic OIDC** - Any OpenID Connect-compliant provider

### How It Works

1. User clicks "Sign in with [Provider]" on login page
2. Dashboard redirects to OIDC provider for authentication
3. User authenticates with provider
4. Provider redirects back to dashboard with authorization code
5. Dashboard exchanges code for user info and creates/links account:
   - If OIDC account already exists (based on provider's user ID), log in
   - If no OIDC account exists:
     - **During initial setup** (no users exist): Create admin account
     - **If user is logged in**: Link OIDC to existing account
     - **If user not logged in** (but users exist): Reject (must log in first to link OIDC)

---

### Authelia Setup

**1. Configure Authelia**

Add Arr Dashboard as an OIDC client in your Authelia configuration:

```yaml
identity_providers:
  oidc:
    clients:
      - id: arr-dashboard
        description: Arr Dashboard
        secret: your-secure-client-secret  # Generate a strong secret
        public: false
        authorization_policy: two_factor   # or one_factor
        redirect_uris:
          - https://arr-dashboard.example.com/auth/oidc/callback
        scopes:
          - openid
          - email
          - profile
        grant_types:
          - authorization_code
        response_types:
          - code
```

**2. Configure Arr Dashboard**

Set these environment variables:

```bash
# Authelia OIDC Configuration
OIDC_AUTHELIA_CLIENT_ID="arr-dashboard"
OIDC_AUTHELIA_CLIENT_SECRET="your-secure-client-secret"
OIDC_AUTHELIA_ISSUER="https://auth.example.com"
OIDC_AUTHELIA_REDIRECT_URI="https://arr-dashboard.example.com/auth/oidc/callback"
OIDC_AUTHELIA_SCOPES="openid,email,profile"  # Optional, defaults to these
```

**3. Docker Compose Example**

```yaml
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    environment:
      - OIDC_AUTHELIA_CLIENT_ID=arr-dashboard
      - OIDC_AUTHELIA_CLIENT_SECRET=your-secure-client-secret
      - OIDC_AUTHELIA_ISSUER=https://auth.example.com
      - OIDC_AUTHELIA_REDIRECT_URI=https://arr-dashboard.example.com/auth/oidc/callback
```

---

### Authentik Setup

**1. Create Application in Authentik**

1. Go to **Applications** → **Providers**
2. Click **Create** → **OAuth2/OpenID Provider**
3. Configure:
   - **Name:** Arr Dashboard
   - **Authorization flow:** Select your flow (e.g., default-authentication-flow)
   - **Client type:** Confidential
   - **Client ID:** arr-dashboard (or auto-generated)
   - **Client Secret:** Save this for later
   - **Redirect URIs:** `https://arr-dashboard.example.com/auth/oidc/callback`
   - **Scopes:** openid, email, profile

4. Create Application:
   - **Name:** Arr Dashboard
   - **Slug:** arr-dashboard
   - **Provider:** Select the provider you just created

**2. Configure Arr Dashboard**

```bash
# Authentik OIDC Configuration
OIDC_AUTHENTIK_CLIENT_ID="arr-dashboard"
OIDC_AUTHENTIK_CLIENT_SECRET="your-client-secret-from-authentik"
OIDC_AUTHENTIK_ISSUER="https://authentik.example.com/application/o/arr-dashboard/"
OIDC_AUTHENTIK_REDIRECT_URI="https://arr-dashboard.example.com/auth/oidc/callback"
```

**Note:** The issuer URL format for Authentik is typically `https://[authentik-domain]/application/o/[slug]/`

---

### Generic OIDC Setup

For other OpenID Connect providers (Keycloak, Okta, Google, etc.):

**1. Register OAuth Application**

In your OIDC provider:
1. Create new OAuth2/OIDC client
2. Set redirect URI: `https://arr-dashboard.example.com/auth/oidc/callback`
3. Enable scopes: `openid`, `email`, `profile`
4. Note the client ID, client secret, and issuer URL

**2. Configure Arr Dashboard**

```bash
# Generic OIDC Configuration
OIDC_GENERIC_CLIENT_ID="your-client-id"
OIDC_GENERIC_CLIENT_SECRET="your-client-secret"
OIDC_GENERIC_ISSUER="https://provider.example.com"
OIDC_GENERIC_REDIRECT_URI="https://arr-dashboard.example.com/auth/oidc/callback"
OIDC_GENERIC_SCOPES="openid,email,profile"  # Optional
```

---

## Environment Variables Reference

### WebAuthn (Passkeys)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEBAUTHN_RP_NAME` | No | `Arr Dashboard` | Display name shown during passkey registration |
| `WEBAUTHN_RP_ID` | No | `localhost` | Your domain without protocol (e.g., `arr.example.com`) |
| `WEBAUTHN_ORIGIN` | No | `http://localhost:3000` | Full origin URL with protocol |

### OIDC - Authelia

| Variable | Required | Description |
|----------|----------|-------------|
| `OIDC_AUTHELIA_CLIENT_ID` | Yes | OAuth client ID from Authelia config |
| `OIDC_AUTHELIA_CLIENT_SECRET` | Yes | OAuth client secret from Authelia config |
| `OIDC_AUTHELIA_ISSUER` | Yes | Authelia base URL (e.g., `https://auth.example.com`) |
| `OIDC_AUTHELIA_REDIRECT_URI` | Yes | Callback URL: `https://your-dashboard/auth/oidc/callback` |
| `OIDC_AUTHELIA_SCOPES` | No | Comma-separated scopes (default: `openid,email,profile`) |

### OIDC - Authentik

| Variable | Required | Description |
|----------|----------|-------------|
| `OIDC_AUTHENTIK_CLIENT_ID` | Yes | OAuth client ID from Authentik |
| `OIDC_AUTHENTIK_CLIENT_SECRET` | Yes | OAuth client secret from Authentik |
| `OIDC_AUTHENTIK_ISSUER` | Yes | Authentik issuer URL (includes `/application/o/[slug]/`) |
| `OIDC_AUTHENTIK_REDIRECT_URI` | Yes | Callback URL: `https://your-dashboard/auth/oidc/callback` |
| `OIDC_AUTHENTIK_SCOPES` | No | Comma-separated scopes (default: `openid,email,profile`) |

### OIDC - Generic

| Variable | Required | Description |
|----------|----------|-------------|
| `OIDC_GENERIC_CLIENT_ID` | Yes | OAuth client ID from your provider |
| `OIDC_GENERIC_CLIENT_SECRET` | Yes | OAuth client secret from your provider |
| `OIDC_GENERIC_ISSUER` | Yes | OIDC issuer URL (used for discovery) |
| `OIDC_GENERIC_REDIRECT_URI` | Yes | Callback URL: `https://your-dashboard/auth/oidc/callback` |
| `OIDC_GENERIC_SCOPES` | No | Comma-separated scopes (default: `openid,email,profile`) |

---

## Security Considerations

### HTTPS in Production

**Always use HTTPS in production** for:
- OIDC callback URLs
- Passkey authentication (WebAuthn requires secure context)
- Session cookie security

Use a reverse proxy like Nginx, Caddy, or Traefik to handle TLS.

### Account Linking

When a user authenticates via OIDC:
- OIDC accounts are linked based on the provider's unique user ID (not email)
- **During initial setup**: First OIDC login creates the admin account
- **After setup**: User must be logged in to link new OIDC provider to their account
- Users can have multiple auth methods (password + OIDC + passkeys)

Passkeys:
- Must be registered while logged in (Settings → Account → Passkeys)
- Linked directly to the user account during registration
- Can have multiple passkeys per account

### Password Optional

Users can authenticate without a password if they have:
- OIDC linked OR
- At least one passkey registered

The database field `User.hashedPassword` is now optional to support OIDC/passkey-only users.

### Session Management

- Sessions are stored server-side with signed HTTP-only cookies
- Session duration: 24 hours (or 30 days with "Remember me")
- CSRF protection via `sameSite: lax` cookie attribute

### Secrets Storage

- All API keys and secrets are encrypted at rest (AES-256-GCM)
- Encryption keys auto-generated on first run (stored in `secrets.json`)
- OIDC state/nonce stored in-memory with 15-minute expiration
- Passkey challenges stored in-memory with 5-minute expiration

**Production Note:** For multi-instance deployments, use Redis for challenge/state storage instead of in-memory storage.

---

## Troubleshooting

### Passkey Registration Fails

**Problem:** "Registration failed" or "This device doesn't support passkeys"

**Solutions:**
1. Ensure you're using HTTPS (or localhost for development)
2. Verify `WEBAUTHN_RP_ID` matches your domain exactly
3. Check browser console for WebAuthn errors
4. Try a different browser (Chrome, Firefox, Safari, Edge all support WebAuthn)

### OIDC Login Redirects to Error

**Problem:** Redirects to error page or shows "Invalid state"

**Solutions:**
1. Verify callback URL matches exactly: `https://your-domain/auth/oidc/callback`
2. Check OIDC provider logs for authentication errors
3. Ensure scopes include `openid`, `email`, `profile`
4. Verify client secret is correct
5. Check that issuer URL supports OIDC discovery (`.well-known/openid-configuration` should exist)

### "No OIDC providers configured"

**Problem:** OIDC buttons don't appear on login page

**Solutions:**
1. Ensure all required environment variables are set (CLIENT_ID, CLIENT_SECRET, ISSUER, REDIRECT_URI)
2. Restart the container/server after setting environment variables
3. Check logs for OIDC configuration errors

### OIDC Account Not Linked

**Problem:** Existing user can't log in with OIDC

**Solution:**
- To link OIDC to existing account: Log in with password first, then initiate OIDC login
- During initial setup (no users exist): First OIDC login creates the account
- OIDC accounts are linked by provider user ID, not email
- After linking, you can use either password or OIDC to log in

---

## Examples

### Complete Docker Compose with Authelia and Passkeys

```yaml
version: '3.8'

services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    container_name: arr-dashboard
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      # Database
      - DATABASE_URL=file:/app/data/prod.db

      # WebAuthn (Passkeys)
      - WEBAUTHN_RP_NAME=Arr Dashboard
      - WEBAUTHN_RP_ID=arr.example.com
      - WEBAUTHN_ORIGIN=https://arr.example.com

      # OIDC - Authelia
      - OIDC_AUTHELIA_CLIENT_ID=arr-dashboard
      - OIDC_AUTHELIA_CLIENT_SECRET=your-secure-client-secret
      - OIDC_AUTHELIA_ISSUER=https://auth.example.com
      - OIDC_AUTHELIA_REDIRECT_URI=https://arr.example.com/auth/oidc/callback
    restart: unless-stopped
```

### Unraid Template with Multiple Auth Methods

```xml
<Environment>
  <Variable>
    <Name>WEBAUTHN_RP_NAME</Name>
    <Value>Arr Dashboard</Value>
  </Variable>
  <Variable>
    <Name>WEBAUTHN_RP_ID</Name>
    <Value>arr.example.com</Value>
  </Variable>
  <Variable>
    <Name>WEBAUTHN_ORIGIN</Name>
    <Value>https://arr.example.com</Value>
  </Variable>
  <Variable>
    <Name>OIDC_AUTHELIA_CLIENT_ID</Name>
    <Value>arr-dashboard</Value>
  </Variable>
  <Variable>
    <Name>OIDC_AUTHELIA_CLIENT_SECRET</Name>
    <Value>your-secret</Value>
  </Variable>
  <Variable>
    <Name>OIDC_AUTHELIA_ISSUER</Name>
    <Value>https://auth.example.com</Value>
  </Variable>
  <Variable>
    <Name>OIDC_AUTHELIA_REDIRECT_URI</Name>
    <Value>https://arr.example.com/auth/oidc/callback</Value>
  </Variable>
</Environment>
```

---

## Need Help?

- **GitHub Issues:** https://github.com/Kha-kis/arr-dashboard/issues
- **Documentation:** https://github.com/Kha-kis/arr-dashboard
- **Discussions:** https://github.com/Kha-kis/arr-dashboard/discussions

When reporting issues, please include:
- Authentication method being used
- Browser and OS
- Relevant error messages from browser console and server logs
- Environment variable configuration (redact secrets)
