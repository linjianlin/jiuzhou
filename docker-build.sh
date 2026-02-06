#!/bin/bash

set -e

REGISTRY="ccr.ccs.tencentyun.com/tcb-100001011660-qtgo"
VERSION=${1:-latest}

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo "🚀 Building and pushing to $REGISTRY..."

log_info "📦 Building client..."
docker build \
    -t $REGISTRY/jiuzhou-client:$VERSION \
    -f client/Dockerfile .

log_info "📦 Building server..."
docker build -t $REGISTRY/jiuzhou-server:$VERSION -f server/Dockerfile .

# Push to registry
log_info "⬆️  Pushing client..."
docker push $REGISTRY/jiuzhou-client:$VERSION

log_info "⬆️  Pushing server..."
docker push $REGISTRY/jiuzhou-server:$VERSION

# Tag as latest if version specified
if [ "$VERSION" != "latest" ]; then
    log_info "🏷️  Tagging as latest..."
    docker tag $REGISTRY/jiuzhou-client:$VERSION $REGISTRY/jiuzhou-client:latest
    docker tag $REGISTRY/jiuzhou-server:$VERSION $REGISTRY/jiuzhou-server:latest
    docker push $REGISTRY/jiuzhou-client:latest
    docker push $REGISTRY/jiuzhou-server:latest
fi

echo ""
log_info "✅ Done! Images pushed to $REGISTRY"
echo "   - $REGISTRY/jiuzhou-client:$VERSION"
echo "   - $REGISTRY/jiuzhou-server:$VERSION"
