# 九州修仙录

一个多人在线修仙主题 RPG 游戏。

## 技术栈

- **前端**: React 19 + TypeScript + Vite + Socket.IO + Zustand
- **后端**: Express 5 + Node.js + TypeScript + Socket.IO
- **数据库**: PostgreSQL 16 + Redis 7
- **部署**: Docker Swarm + Caddy

## 快速开始

### 开发环境

```bash
# 安装依赖
pnpm install

# 启动开发服务器（server 启动前会自动执行 Prisma db push）
pnpm dev
```

### 生产部署

#### 使用 Docker Compose（简单）

```bash
docker-compose up -d
```

#### 使用 Docker Swarm（推荐，支持零停机更新）

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

# 更新后端
docker service update --with-registry-auth --image ccr.ccs.tencentyun.com/tcb-100001011660-qtgo/jiuzhou-server:latest jiuzhou_server

# 或重新部署整个 stack
docker stack deploy --with-registry-auth -c docker-stack.yml jiuzhou
```

后端容器启动时会先自动执行 Prisma `db push`，再启动应用服务。

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
├── server/                 # 后端项目
│   ├── src/
│   │   ├── battle/        # 战斗系统
│   │   ├── config/        # 配置
│   │   ├── game/          # 游戏服务器
│   │   ├── routes/        # API 路由
│   │   └── services/      # 业务服务
│   └── Dockerfile
├── docker-compose.yml      # Docker Compose 配置
├── docker-stack.yml        # Docker Swarm 配置（零停机更新）
└── docker-build.sh         # 构建脚本
```

## 配置文件

| 文件 | 说明 |
|------|------|
| `client/.env.example` | 前端环境变量示例 |
| `docker-compose.yml` | Docker Compose 配置 |
| `docker-stack.yml` | Docker Swarm 配置 |

## License

MIT
