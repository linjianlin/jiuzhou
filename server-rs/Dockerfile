# ==========================================================
# Rust 后端生产镜像
# - 构建 server-rs 二进制
# - 保留现有 server/src/data seeds 与 /uploads/* 挂载点
# ==========================================================

ARG RUST_BASE_IMAGE=rust:1.88-bookworm
ARG RUNTIME_BASE_IMAGE=debian:bookworm-slim

FROM ${RUST_BASE_IMAGE} AS builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY server-rs/Cargo.toml ./server-rs/Cargo.toml
COPY server-rs/Cargo.lock ./server-rs/Cargo.lock
COPY server-rs/migrations ./server-rs/migrations
COPY server-rs/src ./server-rs/src
COPY server/src/data ./server/src/data

WORKDIR /app/server-rs
RUN cargo build --release

FROM ${RUNTIME_BASE_IMAGE} AS runner

WORKDIR /app/server-rs

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=6011
ENV UPLOADS_DIR=/app/server/uploads

COPY --from=builder /app/server-rs/target/release/server-rs ./server-rs
COPY server-rs/.env.example ./.env.example
COPY --from=builder /app/server/src/data /app/server/src/data

RUN mkdir -p /app/server/uploads

EXPOSE 6011

CMD ["./server-rs"]
