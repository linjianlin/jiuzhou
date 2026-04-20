#!/bin/bash

set -e

REGISTRY="ccr.ccs.tencentyun.com/tcb-100001011660-qtgo"
VERSION="latest"
MODE="all"
VERSION_SET=0

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

usage() {
    cat <<'USAGE'
用法:
  ./docker-build.sh [版本号] [--server-only|-s]

参数:
  版本号              镜像标签，默认 latest
  --server-only, -s   只构建并推送 Rust 服务端镜像
USAGE
}

for arg in "$@"; do
    case "$arg" in
        --server-only|-s)
            MODE="server-only"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            if [ "$VERSION_SET" -eq 0 ]; then
                VERSION="$arg"
                VERSION_SET=1
            else
                log_error "无法识别参数: $arg"
                usage
                exit 1
            fi
            ;;
    esac
done

TARGETS=("client" "server")
if [ "$MODE" = "server-only" ]; then
    TARGETS=("server")
fi

get_image_name() {
    local target="$1"
    if [ "$target" = "server" ]; then
        echo "$REGISTRY/jiuzhou-server-rs:$VERSION"
        return
    fi
    echo "$REGISTRY/jiuzhou-$target:$VERSION"
}

build_image() {
    local target="$1"

    if [ "$target" = "client" ]; then
        log_info "📦 Building client..."
        # VITE_CDN_BASE / VITE_API_BASE 从环境变量读取，构建时静态替换到产物中
        docker build \
            -t "$(get_image_name client)" \
            ${VITE_CDN_BASE:+--build-arg VITE_CDN_BASE="$VITE_CDN_BASE"} \
            ${VITE_API_BASE:+--build-arg VITE_API_BASE="$VITE_API_BASE"} \
            -f client/Dockerfile .
        return
    fi

    log_info "📦 Building Rust server..."
    docker build -t "$(get_image_name server)" -f server-rs/Dockerfile .
}

push_image() {
    local target="$1"
    log_info "⬆️  Pushing $target..."
    docker push "$(get_image_name "$target")"
}

tag_latest_image() {
    local target="$1"
    local version_image
    local latest_image

    if [ "$target" = "server" ]; then
        version_image="$REGISTRY/jiuzhou-server-rs:$VERSION"
        latest_image="$REGISTRY/jiuzhou-server-rs:latest"
    else
        version_image="$REGISTRY/jiuzhou-$target:$VERSION"
        latest_image="$REGISTRY/jiuzhou-$target:latest"
    fi

    docker tag "$version_image" "$latest_image"
    docker push "$latest_image"
}

echo "🚀 Building and pushing to $REGISTRY..."

for target in "${TARGETS[@]}"; do
    build_image "$target"
done

for target in "${TARGETS[@]}"; do
    push_image "$target"
done

# Tag as latest if version specified
if [ "$VERSION" != "latest" ]; then
    log_info "🏷️  Tagging as latest..."
    for target in "${TARGETS[@]}"; do
        tag_latest_image "$target"
    done
fi

echo ""
log_info "✅ Done! Images pushed to $REGISTRY"
for target in "${TARGETS[@]}"; do
    echo "   - $(get_image_name "$target")"
done
