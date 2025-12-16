# Multi-Authentication Setup Guide

Arr Dashboard supports multiple authentication methods:
- **Password Authentication** - Traditional username/password login (default)
- **OIDC/OAuth2** - External authentication providers (Authelia, Authentik, Keycloak, etc.)
- **Passkeys (WebAuthn)** - Passwordless authentication using biometrics or security keys

## Table of Contents

- [Quick Start](#quick-start)
- [Password Authentication](#password-authentication)
- [Passkey Authentication](#passkey-authentication)
- [OIDC Authentication](#oidc-authentication)
  - [Configuring OIDC](#configuring-oidc)
  - [Provider Examples](#provider-examples)
- [Environment Variables Reference](#environment-variables-reference)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

### Option 1: Password Authentication (Default)

No configuration needed. Create the first user on initial setup:

1. Navigate to `http://your-server:3000/setup`
2. Select **Password** authentication
3. Create an admin account with username and password
4. Log in with your credentials

### Option 2: OIDC Authentication

Configure OIDC during initial setup:

1. Navigate to `http://your-server:3000/setup`
2. Select **OIDC** authentication
3. Enter your OIDC provider details (client ID, secret, issuer URL)
4. Complete login through your OIDC provider
5. Admin account is created automatically from OIDC profile

### Adding Passkeys (After Setup)

Passkeys can be added to password-authenticated accounts:

1. Log in to your account
2. Go to **Settings** → **Account** tab
3. Scroll to **Passkeys** section
4. Click **Add Passkey** and follow your device's prompts
5. Next login, click **Sign in with passkey** button

> **Note:** Passkeys are only available for password-authenticated accounts. OIDC users authenticate through their identity provider.

---

## Password Authentication

Password authentication is the default method for new installations.

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

- **Password account** - Passkeys are only available for password-authenticated users
- **HTTPS** required in production (localhost works over HTTP for development)
- Modern browser with WebAuthn support (Chrome, Firefox, Safari, Edge)
- Device with biometric authentication or external security key

### Environment Variables (WebAuthn)

```bash
# Required for passkey authentication in production
WEBAUTHN_RP_NAME="Arr Dashboard"                    # Relying Party name shown to users
WEBAUTHN_RP_ID="arr-dashboard.example.com"          # Your domain (no protocol, no port)
WEBAUTHN_ORIGIN="https://arr-dashboard.example.com" # Full URL with protocol
```

**Important:**
- `WEBAUTHN_RP_ID` must match your domain exactly (no `https://`, no port)
- `WEBAUTHN_ORIGIN` must include protocol and match where users access the dashboard
- For localhost development: `WEBAUTHN_RP_ID="localhost"` and `WEBAUTHN_ORIGIN="http://localhost:3000"`

### Docker Example with Passkeys

```yaml
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    volumes:
      - ./config:/config
    environment:
      - PUID=1000
      - PGID=1000
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

OIDC (OpenID Connect) allows users to authenticate using external identity providers like Authelia, Authentik, Keycloak, Okta, and others.

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

### Configuring OIDC

OIDC is configured through the **web interface**, not environment variables.

#### During Initial Setup

1. Navigate to `/setup`
2. Select **OIDC** authentication
3. Fill in the configuration form:
   - **Display Name**: How the provider appears on login page
   - **Client ID**: From your OIDC provider
   - **Client Secret**: From your OIDC provider
   - **Issuer URL**: Your provider's OIDC issuer URL
   - **Redirect URI**: Auto-generated (defaults to `https://your-domain/auth/oidc/callback`)
   - **Scopes**: Comma-separated list (default: `openid,email,profile`)

#### After Initial Setup (Admin Settings)

1. Log in with your existing account
2. Go to **Settings** → **OIDC** tab
3. Configure the OIDC provider with the same fields as above
4. Click **Save** to enable OIDC login

> **Note:** Only one OIDC provider can be configured at a time. To change providers, delete the existing configuration first.

### Provider Examples

#### Authelia Setup

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

In the setup page or settings, enter:
- **Display Name**: Authelia
- **Client ID**: `arr-dashboard`
- **Client Secret**: `your-secure-client-secret`
- **Issuer URL**: `https://auth.example.com`

The redirect URI is auto-generated based on your domain.

#### Authentik Setup

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

In the setup page or settings, enter:
- **Display Name**: Authentik
- **Client ID**: `arr-dashboard`
- **Client Secret**: Your client secret from Authentik
- **Issuer URL**: `https://authentik.example.com/application/o/arr-dashboard/`

> **Note:** The issuer URL format for Authentik is typically `https://[authentik-domain]/application/o/[slug]/`

#### Generic OIDC Provider

For other OpenID Connect providers (Keycloak, Okta, Google, etc.):

**1. Register OAuth Application**

In your OIDC provider:
1. Create new OAuth2/OIDC client
2. Set redirect URI: `https://arr-dashboard.example.com/auth/oidc/callback`
3. Enable scopes: `openid`, `email`, `profile`
4. Note the client ID, client secret, and issuer URL

**2. Configure Arr Dashboard**

In the setup page or settings, enter:
- **Display Name**: Your provider name
- **Client ID**: Your client ID
- **Client Secret**: Your client secret
- **Issuer URL**: Your provider's OIDC issuer URL (must support `.well-known/openid-configuration`)

---

## Environment Variables Reference

### WebAuthn (Passkeys)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEBAUTHN_RP_NAME` | No | `Arr Dashboard` | Display name shown during passkey registration |
| `WEBAUTHN_RP_ID` | No | `localhost` | Your domain without protocol (e.g., `arr.example.com`) |
| `WEBAUTHN_ORIGIN` | No | `http://localhost:3000` | Full origin URL with protocol |

### Session & Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSION_TTL_HOURS` | No | `24` | Session expiration time in hours |
| `ENCRYPTION_KEY` | No | Auto-generated | 32-byte hex key for AES-256-GCM encryption |
| `SESSION_COOKIE_SECRET` | No | Auto-generated | 32-byte hex key for cookie signing |

> **Note:** OIDC is NOT configured via environment variables. Use the web interface (Setup page or Settings) to configure OIDC providers. This allows secure storage of the client secret in the encrypted database.

---

## Security Considerations

### HTTPS in Production

**Always use HTTPS in production** for:
- OIDC callback URLs
- Passkey authentication (WebAuthn requires secure context)
- Session cookie security

Use a reverse proxy like Nginx, Caddy, or Traefik to handle TLS.

### Authentication Method Selection

Choose your authentication method based on your needs:

| Method | Use Case | Notes |
|--------|----------|-------|
| **Password** | Simple setup, local network | Default, supports passkeys |
| **OIDC** | Enterprise, SSO integration | Centralized auth management |
| **Password + Passkeys** | Enhanced security | Passwordless option for password users |

### Account Linking

**OIDC accounts:**
- Linked based on the provider's unique user ID (not email)
- **During initial setup**: First OIDC login creates the admin account
- **After setup**: User must be logged in to link OIDC provider to their account

**Passkeys:**
- Must be registered while logged in (Settings → Account → Passkeys)
- Linked directly to the user account during registration
- Can have multiple passkeys per account
- Only available for password-authenticated accounts

### Session Management

- Sessions are stored server-side with signed HTTP-only cookies
- Session duration: 24 hours (or 30 days with "Remember me")
- CSRF protection via `sameSite: lax` cookie attribute
- All sessions invalidated when security-critical settings change

### Secrets Storage

- All secrets (API keys, OIDC client secrets) are encrypted at rest (AES-256-GCM)
- Encryption keys auto-generated on first run (stored in `/config/secrets.json`)
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
4. Verify client secret is correct in Settings
5. Check that issuer URL supports OIDC discovery (`.well-known/openid-configuration` should exist)

### "No OIDC providers configured"

**Problem:** OIDC button doesn't appear on login page

**Solutions:**
1. Configure OIDC through Settings → OIDC (not environment variables)
2. Ensure the provider is enabled after configuration
3. Restart the container/server after making changes
4. Check logs for OIDC configuration errors

### OIDC Account Not Linked

**Problem:** Existing user can't log in with OIDC

**Solution:**
- To link OIDC to existing account: Log in with password first, then initiate OIDC login
- During initial setup (no users exist): First OIDC login creates the account
- OIDC accounts are linked by provider user ID, not email
- After linking, you can use either method to log in

### Passkeys Not Available

**Problem:** Passkey option doesn't appear in Settings

**Solutions:**
1. Passkeys are only available for password-authenticated accounts
2. If using OIDC, passkeys are managed by your identity provider
3. Ensure WebAuthn environment variables are set for production

---

## Examples

### Docker Compose with Password + Passkeys

```yaml
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    container_name: arr-dashboard
    ports:
      - "3000:3000"
    volumes:
      - ./config:/config
    environment:
      # User/Group IDs
      - PUID=1000
      - PGID=1000
      # WebAuthn (Passkeys)
      - WEBAUTHN_RP_NAME=Arr Dashboard
      - WEBAUTHN_RP_ID=arr.example.com
      - WEBAUTHN_ORIGIN=https://arr.example.com
    restart: unless-stopped
```

### Docker Compose for OIDC Setup

```yaml
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    container_name: arr-dashboard
    ports:
      - "3000:3000"
    volumes:
      - ./config:/config
    environment:
      # User/Group IDs
      - PUID=1000
      - PGID=1000
    restart: unless-stopped
```

> **Note:** OIDC configuration is done through the web interface during setup or in Settings. No OIDC environment variables are needed.

---

## Need Help?

- **GitHub Issues:** https://github.com/Kha-kis/arr-dashboard/issues
- **Documentation:** https://github.com/Kha-kis/arr-dashboard
- **Discussions:** https://github.com/Kha-kis/arr-dashboard/discussions

When reporting issues, please include:
- Authentication method being used
- Browser and OS
- Relevant error messages from browser console and server logs
- OIDC provider type (if applicable)
