# 数据库外挂监控（Prometheus + Grafana）

## 组成
- `postgres-exporter`：采集 PostgreSQL 指标
- `prometheus`：抓取与存储指标
- `grafana`：可视化与告警

## 暴露端口
- Prometheus: `9090`
- Grafana: `3000`

## 启动后首次初始化（只需执行一次）
> 已在 `docker-stack.yml` 中为 PostgreSQL 启用 `pg_stat_statements + auto_explain` 预加载与慢查询日志参数。

在 PostgreSQL 中执行：

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

## 慢查询与无索引查询监控

### 1) Prometheus/Grafana 趋势指标（Prometheus 数据源）
- 活跃连接数：
  ```promql
  sum(pg_stat_activity_count{state="active"})
  ```
- 事务吞吐（TPS）：
  ```promql
  sum(rate(pg_stat_database_xact_commit[1m]) + rate(pg_stat_database_xact_rollback[1m]))
  ```
- 顺序扫描速率（疑似未命中索引趋势）：
  ```promql
  sum(rate(pg_stat_user_tables_seq_scan[5m]))
  ```
- 索引扫描速率：
  ```promql
  sum(rate(pg_stat_user_tables_idx_scan[5m]))
  ```

### 2) 具体 SQL 排查（PostgreSQL 查询）
- 历史慢 SQL（按总耗时）：
  ```sql
  SELECT
    queryid,
    calls,
    total_exec_time,
    mean_exec_time,
    rows,
    left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query
  FROM pg_stat_statements
  ORDER BY total_exec_time DESC
  LIMIT 20;
  ```
- 当前执行中 SQL（实时）：
  ```sql
  SELECT
    pid,
    usename,
    state,
    wait_event_type,
    now() - query_start AS duration,
    left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query
  FROM pg_stat_activity
  WHERE state <> 'idle'
  ORDER BY duration DESC;
  ```
- 疑似无索引热点表（高顺序扫描）：
  ```sql
  SELECT
    relname,
    seq_scan,
    idx_scan,
    n_live_tup
  FROM pg_stat_user_tables
  WHERE n_live_tup > 10000
  ORDER BY seq_scan DESC
  LIMIT 20;
  ```

### 3) 日志查看（auto_explain 输出）
- `auto_explain` 和 `log_min_duration_statement` 会写入 PostgreSQL 日志。
- 在容器环境可通过 PostgreSQL 容器日志查看执行计划与慢 SQL 明细。

## Grafana 默认账号
- 用户名：`admin`（可通过 `GRAFANA_ADMIN_USER` 覆盖）
- 密码：`admin123`（可通过 `GRAFANA_ADMIN_PASSWORD` 覆盖）

## 说明
- Grafana 已自动预置 Prometheus 数据源（`Prometheus`）。
- 当前 Prometheus 抓取目标定义在 `ops/monitoring/prometheus.yml`。
