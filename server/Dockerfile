# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm and set registry
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    pnpm config set registry https://registry.npmmirror.com

# Copy workspace config and ALL package.json files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY server/prisma ./server/prisma/

# Install ALL dependencies (workspace mode)
RUN pnpm install --frozen-lockfile

# Generate Prisma client
WORKDIR /app/server
RUN pnpm db:generate

# Copy server source
WORKDIR /app
COPY server ./server

# Build server
WORKDIR /app/server
RUN pnpm build

# Production stage
FROM node:22-alpine

WORKDIR /app/server

# Install pnpm and set registry
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    pnpm config set registry https://registry.npmmirror.com

# Copy package files
COPY server/package.json ./
COPY server/prisma ./prisma/

# Install production dependencies
RUN pnpm install --prod

# Generate Prisma client
RUN pnpm db:generate

# Copy built files
COPY --from=builder /app/server/dist ./dist

# Copy data seeds
COPY server/src/data ./src/data

# Create uploads directory
RUN mkdir -p uploads

EXPOSE 6011

CMD ["node", "dist/app.js"]
