# ==========================================================
# 模块作用：
# 1) 在独立阶段完成 server 构建与生产依赖准备
# 2) 最终运行镜像只复制“运行必需文件”，避免把安装过程层带入最终镜像
#
# 输入/输出：
# - 输入：workspace 清单、server 源码、Prisma schema
# - 输出：server/dist + 生产依赖 node_modules + Prisma Client
#
# 数据流：
# base(工具链) -> builder(编译产物) + prod-deps(生产依赖) -> runner(最小运行镜像)
#
# 关键边界条件与坑点：
# 1) prisma generate 必须在 Linux Alpine 环境执行，确保引擎与运行时一致
# 2) pnpm 的 store/cache 必须在“同一 RUN 层”清理，否则历史层体积不会下降
# ==========================================================

# =======================================
# 基础工具链阶段：统一 pnpm 与镜像源配置
# =======================================
FROM node:22-alpine AS base

WORKDIR /app

# 固定包管理器配置，保障各阶段安装行为一致
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    pnpm config set registry https://registry.npmmirror.com

# Prisma 引擎镜像与各阶段保持一致，避免生成产物不一致
ENV PRISMA_ENGINES_MIRROR="https://registry.npmmirror.com/-/binary/prisma"

# =======================================
# 构建阶段：安装构建所需依赖并编译 server
# =======================================
FROM base AS builder

# 先复制清单文件，最大化依赖安装缓存命中
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY server/prisma ./server/prisma/

# 仅安装 server 构建所需依赖，避免无关包进入构建图
RUN pnpm install --frozen-lockfile --filter ./server...

# 再复制服务端源码，降低源码变更对依赖层缓存的影响
COPY server ./server

# 在构建阶段生成 Prisma Client 并编译 TypeScript
RUN pnpm --filter ./server db:generate && \
    pnpm --filter ./server build

# =======================================
# 生产依赖阶段：只保留运行时依赖与 Prisma Client
# =======================================
FROM base AS prod-deps

# 仅复制依赖解析所需文件，不复制源码
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY server/prisma ./server/prisma/

# 在同一层完成安装 + 生成 + 清理，确保历史层不残留大体积缓存
RUN pnpm install --prod --frozen-lockfile --filter ./server... --package-import-method=copy && \
    pnpm --filter ./server db:generate && \
    rm -rf /root/.local/share/pnpm/store /root/.cache

# =======================================
# 运行阶段：仅复制运行必需文件，避免携带安装层
# =======================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# 从生产依赖阶段复制运行必需依赖，避免在 runner 阶段执行安装
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules

WORKDIR /app/server

# 拷贝构建产物与运行时数据文件
COPY --from=builder /app/server/dist ./dist
COPY server/src/data ./src/data
COPY server/package.json ./package.json

# 预创建上传目录，便于容器内运行及挂载卷
RUN mkdir -p uploads

EXPOSE 6011

CMD ["node", "dist/app.js"]
