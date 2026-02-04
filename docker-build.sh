#!/bin/bash

set -e

REGISTRY="ccr.ccs.tencentyun.com/tcb-100001011660-qtgo"
VERSION=${1:-latest}

echo "🚀 Building and pushing to $REGISTRY..."

# Build images from root directory
echo "📦 Building client..."
docker build -t $REGISTRY/jiuzhou-client:$VERSION -f client/Dockerfile .

echo "📦 Building server..."
docker build -t $REGISTRY/jiuzhou-server:$VERSION -f server/Dockerfile .

# Push to registry
echo "⬆️  Pushing client..."
docker push $REGISTRY/jiuzhou-client:$VERSION

echo "⬆️  Pushing server..."
docker push $REGISTRY/jiuzhou-server:$VERSION

# Tag as latest if version specified
if [ "$VERSION" != "latest" ]; then
    echo "🏷️  Tagging as latest..."
    docker tag $REGISTRY/jiuzhou-client:$VERSION $REGISTRY/jiuzhou-client:latest
    docker tag $REGISTRY/jiuzhou-server:$VERSION $REGISTRY/jiuzhou-server:latest
    docker push $REGISTRY/jiuzhou-client:latest
    docker push $REGISTRY/jiuzhou-server:latest
fi

echo "✅ Done! Images pushed to $REGISTRY"
echo "   - $REGISTRY/jiuzhou-client:$VERSION"
echo "   - $REGISTRY/jiuzhou-server:$VERSION"
