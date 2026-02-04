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

# 启动开发服务器
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

# 部署服务
docker stack deploy -c docker-stack.yml jiuzhou

# 查看服务状态
docker stack services jiuzhou
```

**更新服务（零停机）：**

```bash
# 更新前端
docker service update --image ccr.ccs.tencentyun.com/tcb-100001011660-qtgo/jiuzhou-client:latest jiuzhou_client

# 更新后端
docker service update --image ccr.ccs.tencentyun.com/tcb-100001011660-qtgo/jiuzhou-server:latest jiuzhou_server

# 或重新部署整个 stack
docker stack deploy -c docker-stack.yml jiuzhou
```

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

### 使用 CDN 加速（推荐）

配置腾讯云 COS 后，构建时会自动上传静态资源到 CDN，减少源站流量。

#### 1. 安装 coscmd

```bash
pip install coscmd
```

#### 2. 配置腾讯云认证

```bash
coscmd config \
  -a <SecretId> \
  -s <SecretKey> \
  -b <Bucket> \
  -r <Region>
```

#### 3. 构建并上传

```bash
# 使用 COS 默认域名
COS_BUCKET=my-bucket-1234567890 ./docker-build.sh latest

# 使用 CDN 加速域名
COS_BUCKET=my-bucket-1234567890 \
CDN_DOMAIN=cdn.example.com \
./docker-build.sh latest
```

#### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `COS_BUCKET` | COS 存储桶名称 | - |
| `COS_REGION` | COS 区域 | `ap-guangzhou` |
| `COS_PATH` | COS 路径前缀 | `/jiuzhou` |
| `CDN_DOMAIN` | CDN 加速域名 | COS 默认域名 |

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
├── docker-build.sh         # 构建脚本
└── upload-cos.sh           # COS 上传脚本
```

## 配置文件

| 文件 | 说明 |
|------|------|
| `.env.cos.example` | COS 配置示例 |
| `client/.env.example` | 前端环境变量示例 |
| `docker-compose.yml` | Docker Compose 配置 |
| `docker-stack.yml` | Docker Swarm 配置 |

## License

MIT
