#!/bin/bash
# Build and push a dev Docker image without affecting latest

set -e

DOCKERHUB_IMAGE="khak1s/arr-dashboard"
GHCR_IMAGE="ghcr.io/khak1s/arr-dashboard"
DEV_TAG="dev-$(date +%Y%m%d-%H%M%S)"

echo "Building dev image with tag: $DEV_TAG"

# Build multi-platform image
docker buildx build --platform linux/amd64,linux/arm64 \
  -t "$DOCKERHUB_IMAGE:dev" \
  -t "$DOCKERHUB_IMAGE:$DEV_TAG" \
  -t "$GHCR_IMAGE:dev" \
  -t "$GHCR_IMAGE:$DEV_TAG" \
  --push \
  .

echo ""
echo "✅ Dev image pushed successfully!"
echo ""
echo "Docker Hub tags:"
echo "  - $DOCKERHUB_IMAGE:dev"
echo "  - $DOCKERHUB_IMAGE:$DEV_TAG"
echo ""
echo "GHCR tags:"
echo "  - $GHCR_IMAGE:dev"
echo "  - $GHCR_IMAGE:$DEV_TAG"
echo ""
echo "To use in docker-compose, update image to:"
echo "  image: $DOCKERHUB_IMAGE:dev"
