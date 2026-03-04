# 数据库外挂监控（Prometheus + Grafana）

## 组成
- `postgres-exporter`：采集 PostgreSQL 指标
- `prometheus`：抓取与存储指标
- `grafana`：可视化与告警

## 暴露端口
- Prometheus: `9090`
- Grafana: `3000`

## 启动后首次初始化（只需执行一次）
> 已在 `docker-stack.yml` 中为 PostgreSQL 启用 `pg_stat_statements` 预加载。

在 PostgreSQL 中执行：

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

## Grafana 默认账号
- 用户名：`admin`（可通过 `GRAFANA_ADMIN_USER` 覆盖）
- 密码：`admin123`（可通过 `GRAFANA_ADMIN_PASSWORD` 覆盖）

## 说明
- Grafana 已自动预置 Prometheus 数据源（`Prometheus`）。
- 当前 Prometheus 抓取目标定义在 `ops/monitoring/prometheus.yml`。
