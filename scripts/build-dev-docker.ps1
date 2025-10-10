# Build and push a dev Docker image without affecting latest
# PowerShell version for Windows

$ErrorActionPreference = "Stop"

$DOCKERHUB_IMAGE = "khak1s/arr-dashboard"
$GHCR_IMAGE = "ghcr.io/khak1s/arr-dashboard"
$DEV_TAG = "dev-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

Write-Host "Building dev image with tag: $DEV_TAG" -ForegroundColor Cyan

# Build multi-platform image
docker buildx build --platform linux/amd64,linux/arm64 `
  -t "${DOCKERHUB_IMAGE}:dev" `
  -t "${DOCKERHUB_IMAGE}:${DEV_TAG}" `
  -t "${GHCR_IMAGE}:dev" `
  -t "${GHCR_IMAGE}:${DEV_TAG}" `
  --push `
  .

Write-Host ""
Write-Host "✅ Dev image pushed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Docker Hub tags:" -ForegroundColor Yellow
Write-Host "  - ${DOCKERHUB_IMAGE}:dev"
Write-Host "  - ${DOCKERHUB_IMAGE}:${DEV_TAG}"
Write-Host ""
Write-Host "GHCR tags:" -ForegroundColor Yellow
Write-Host "  - ${GHCR_IMAGE}:dev"
Write-Host "  - ${GHCR_IMAGE}:${DEV_TAG}"
Write-Host ""
Write-Host "To use in docker-compose, update image to:" -ForegroundColor Cyan
Write-Host "  image: ${DOCKERHUB_IMAGE}:dev"
