# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm and set registry
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    pnpm config set registry https://registry.npmmirror.com

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter client

# Copy client source
COPY client ./client

# Build
RUN pnpm --filter client build

# Production stage
FROM caddy:alpine

# Copy built files
COPY --from=builder /app/client/dist /srv

# Copy Caddyfile
COPY client/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
