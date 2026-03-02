# Build stage
FROM guergeiro/pnpm:22-10-alpine AS builder

WORKDIR /app

# Vite 构建时环境变量（通过 --build-arg 传入，可选）
ARG VITE_API_BASE=""
ARG VITE_CDN_BASE=""

# 配置 pnpm 镜像源与 lockfile 相关配置
# 说明：
# 1) auto-install-peers 必须与 pnpm-lock.yaml.settings.autoInstallPeers 一致
# 否则 --frozen-lockfile 会触发配置不匹配错误并中断构建
RUN pnpm config set registry https://registry.npmmirror.com && \
    pnpm config set auto-install-peers true

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter client

# Copy client source
COPY client ./client

# Build with Vite env vars
ENV VITE_API_BASE=${VITE_API_BASE}
ENV VITE_CDN_BASE=${VITE_CDN_BASE}
RUN pnpm --filter client build

# Production stage
FROM caddy:alpine

# Copy built files
COPY --from=builder /app/client/dist /srv

# Copy Caddyfile
COPY client/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
