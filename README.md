# 九州修仙录

一个多人在线修仙主题 RPG 游戏。

## 技术栈

- **前端**: React 19 + TypeScript + Vite + Socket.IO + Zustand
- **当前后端**: Rust + Axum + Socket.IO（`server-rs/`）
- **遗留基线/参考实现**: Node.js + TypeScript（`server/`，用于协议对照、seed 与回归参考）
- **数据库**: PostgreSQL 16 + Redis 7
- **部署**: Docker Swarm + Caddy

## 快速开始

### 开发环境

```bash
# 安装依赖
pnpm install

# 启动前端 + Rust 后端（默认开发入口）
pnpm dev

# 若需对照遗留 Node 基线
pnpm dev:server:node
```

### 生产部署

#### 使用 Docker Swarm（当前部署入口）

```bash
# 初始化 Swarm（首次）
docker swarm init

# 部署服务（--with-registry-auth 传递镜像仓库认证信息）
docker stack deploy --with-registry-auth -c docker-stack.yml jiuzhou

# 查看服务状态
docker stack services jiuzhou
```

**更新服务（零停机）：**

```bash
# 更新前端
docker service update --with-registry-auth --image ccr.ccs.tencentyun.com/tcb-100001011660-qtgo/jiuzhou-client:latest jiuzhou_client

# 更新 Rust 后端
docker service update --with-registry-auth --image ccr.ccs.tencentyun.com/tcb-100001011660-qtgo/jiuzhou-server-rs:latest jiuzhou_server

# 或重新部署整个 stack
docker stack deploy --with-registry-auth -c docker-stack.yml jiuzhou
```

当前 Swarm 配置默认部署 Rust 后端；遗留 Node `server/` 保留为协议/seed/参考实现，不再作为默认生产服务入口。

**常用管理命令：**

```bash
# 查看服务日志
docker service logs jiuzhou_server -f

# 回滚到上一版本
docker service rollback jiuzhou_client

# 删除整个 stack
docker stack rm jiuzhou
```

## 构建与部署

### 基本构建

```bash
# 构建并推送镜像
./docker-build.sh latest
```

## 项目结构

```
.
├── client/                 # 前端项目
│   ├── src/
│   │   ├── assets/        # 静态资源
│   │   ├── components/    # 通用组件
│   │   ├── pages/         # 页面
│   │   └── services/      # API 服务
│   ├── Dockerfile
│   └── Caddyfile
├── server-rs/              # Rust 后端项目（当前实现）
│   ├── src/
│   └── Dockerfile
├── server/                 # 遗留 Node 基线 / 协议参考 / seed 数据
│   ├── src/
│   │   ├── battle/
│   │   ├── config/
│   │   ├── game/
│   │   ├── routes/
│   │   └── services/
│   └── Dockerfile
├── docker-stack.yml        # Docker Swarm 配置（零停机更新）
└── docker-build.sh         # 构建脚本
```

## 配置文件

| 文件 | 说明 |
|------|------|
| `client/.env.example` | 前端环境变量示例 |
| `server-rs/.env.example` | Rust 后端环境变量示例 |
| `docker-stack.yml` | Docker Swarm 配置 |

## License

MIT
