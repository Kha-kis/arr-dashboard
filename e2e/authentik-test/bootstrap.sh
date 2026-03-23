#!/bin/bash
# Bootstrap Authentik OIDC provider for arr-dashboard testing
#
# This script:
# 1. Waits for Authentik to be healthy
# 2. Completes initial admin setup via Playwright
# 3. Creates an OIDC provider and application via the API
# 4. Writes credentials to .env.test for the Playwright spec
#
# Prerequisites: docker compose up -d
# Usage: bash bootstrap.sh

set -euo pipefail

AUTHENTIK_URL="${AUTHENTIK_URL:-http://localhost:9000}"
ARR_DASHBOARD_URL="${ARR_DASHBOARD_URL:-http://localhost:3000}"
ADMIN_PASSWORD="TestPassword123!"
ADMIN_EMAIL="admin@test.local"
APP_SLUG="arr-dashboard-test"
CLIENT_ID="arr-dashboard-e2e-test"
CLIENT_SECRET="e2e-test-secret-value-$(openssl rand -hex 8)"

echo "🔧 Bootstrapping Authentik OIDC for arr-dashboard testing..."

# Wait for Authentik
echo "⏳ Waiting for Authentik..."
for i in $(seq 1 60); do
  if curl -sf "$AUTHENTIK_URL/-/health/ready/" > /dev/null 2>&1; then
    echo "✅ Authentik is ready"
    break
  fi
  [ "$i" -eq 60 ] && echo "❌ Timeout" && exit 1
  sleep 5
done

# Step 1: Complete initial setup via Playwright
echo "🔧 Completing initial admin setup..."
npx playwright-cli open "$AUTHENTIK_URL/if/flow/initial-setup/" 2>/dev/null

sleep 3

npx playwright-cli run-code "async (page) => {
  await page.waitForTimeout(2000);
  const emailInput = page.getByRole('textbox', { name: 'Admin email' });
  if (await emailInput.count() > 0) {
    await emailInput.fill('$ADMIN_EMAIL');
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill('$ADMIN_PASSWORD');
    await page.getByRole('textbox', { name: 'Password (repeat)' }).fill('$ADMIN_PASSWORD');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(3000);
    return 'Setup completed';
  }
  return 'Already set up';
}" 2>/dev/null

# Step 2: Create OIDC provider via API (using Playwright session)
echo "🔧 Creating OIDC provider and application..."
RESULT=$(npx playwright-cli run-code "async (page) => {
  // Log in if needed
  if (page.url().includes('flow')) {
    await page.getByRole('textbox', { name: 'Email or Username' }).fill('akadmin');
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForTimeout(1000);
    await page.getByRole('textbox', { name: 'Please enter your password' }).fill('$ADMIN_PASSWORD');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(3000);
  }

  const cookies = await page.context().cookies();
  const csrf = cookies.find(c => c.name === 'authentik_csrf')?.value;

  async function api(path, method, body) {
    return page.evaluate(async ({path, method, body, csrf}) => {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-authentik-CSRF': csrf },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    }, {path, method, body, csrf});
  }

  const flows = await api('/api/v3/flows/instances/', 'GET');
  const authFlow = flows.body.results?.find(f => f.slug === 'default-authentication-flow')?.pk;
  const invalidFlow = flows.body.results?.find(f => f.slug.includes('invalidation'))?.pk || authFlow;
  const keys = await api('/api/v3/crypto/certificatekeypairs/', 'GET');
  const keyUuid = keys.body.results?.[0]?.pk;

  const provider = await api('/api/v3/providers/oauth2/', 'POST', {
    name: '$APP_SLUG-provider',
    authorization_flow: authFlow,
    invalidation_flow: invalidFlow,
    client_type: 'confidential',
    client_id: '$CLIENT_ID',
    client_secret: '$CLIENT_SECRET',
    redirect_uris: [{ matching_mode: 'strict', url: '$ARR_DASHBOARD_URL/auth/oidc/callback' }],
    signing_key: keyUuid,
    access_token_validity: 'hours=1',
    sub_mode: 'user_username',
    include_claims_in_id_token: true,
  });

  if (provider.status !== 201) return 'ERROR:Provider:' + JSON.stringify(provider.body);

  const app = await api('/api/v3/core/applications/', 'POST', {
    name: '$APP_SLUG',
    slug: '$APP_SLUG',
    provider: provider.body.pk,
  });

  if (app.status !== 201) return 'ERROR:App:' + JSON.stringify(app.body);

  const disc = await page.evaluate(async () => {
    const res = await fetch('/application/o/$APP_SLUG/.well-known/openid-configuration');
    return res.ok ? await res.json() : null;
  });

  return JSON.stringify({ issuer: disc?.issuer });
}" 2>/dev/null | grep -o '{.*}')

npx playwright-cli close 2>/dev/null

ISSUER_URL=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['issuer'])")

echo ""
echo "✅ Authentik OIDC setup complete!"
echo "============================================"
echo "ISSUER_URL=$ISSUER_URL"
echo "CLIENT_ID=$CLIENT_ID"
echo "CLIENT_SECRET=$CLIENT_SECRET"
echo "============================================"

cat > "$(dirname "$0")/.env.test" << EOF
AUTHENTIK_ISSUER_URL=$ISSUER_URL
AUTHENTIK_CLIENT_ID=$CLIENT_ID
AUTHENTIK_CLIENT_SECRET=$CLIENT_SECRET
AUTHENTIK_ADMIN_USERNAME=akadmin
AUTHENTIK_ADMIN_PASSWORD=$ADMIN_PASSWORD
AUTHENTIK_URL=$AUTHENTIK_URL
ARR_DASHBOARD_URL=$ARR_DASHBOARD_URL
EOF
echo "📄 Wrote credentials to .env.test"
