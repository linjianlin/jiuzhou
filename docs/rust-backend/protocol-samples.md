# Rust 后端协议样本与错误语义样本

本文档补齐 `RUST_BACKEND_REWRITE_PLAN.md` 阶段 0 中“关键接口请求/响应结构样本、关键错误场景样本、关键 Socket 事件载荷样本”。

## 1. HTTP 响应包装样本

大多数 HTTP 接口保持以下包装：

```json
{
  "success": true,
  "message": "获取成功",
  "data": {}
}
```

失败时即使 HTTP 200，业务体也可能返回：

```json
{
  "success": false,
  "message": "灵石不足"
}
```

## 2. 典型错误语义样本

### 2.1 socket 侧

- `game:error { message: "认证失败" }`
- `game:error { message: "未认证" }`
- `game:error { message: "缺少战斗ID" }`
- `game:error { message: "无效的属性" }`
- `chat:error { message: "消息内容不能为空" }`
- `chat:error { message: "系统频道不允许发言" }`
- `chat:error { message: "战况频道不允许发言" }`
- `chat:error { message: "缺少私聊对象" }`
- `chat:error { message: "私聊对象无效" }`
- `chat:error { message: "对方不在线" }`

### 2.2 inventory / growth / gem

- `recipeId参数错误`
- `itemId参数错误`
- `qty参数错误`
- `targetLevel参数错误`
- `selectedGemItemIds参数错误，需要手动选择2个宝石`
- `请通过使用扩容道具进行扩容`

## 3. 首包 realtime 样本

认证成功后的高优先级首包约束：

1. `game:character { type: "full" }`
2. overview 补发：`sect:update` / `task:update` / `mail:update` / `achievement:update` / `partnerRecruit:update` / `partnerFusion:update` / `partnerRebone:update` / `techniqueResearch:update`
3. 若存在当前 battle，则补发 `battle:update` 与 cooldown 事件
4. `game:time-sync`
5. `game:auth-ready`

## 4. 典型 Socket 载荷样本

### 4.1 `game:character`

```json
{
  "type": "full",
  "character": {
    "id": 1001,
    "nickname": "韩立",
    "avatar": "/uploads/avatars/demo.png"
  }
}
```

### 4.2 `mail:update`

```json
{
  "unreadCount": 3,
  "unclaimedCount": 1,
  "source": "auth_sync"
}
```

### 4.3 `task:update`

```json
{
  "characterId": 1001,
  "scopes": ["task"]
}
```

### 4.4 `battle:update`

```json
{
  "kind": "battle_state",
  "battleId": "battle-1001",
  "authoritative": true
}
```

## 5. 样本来源

- `server-rs/src/http/routes.rs`
- `server-rs/src/realtime/public_socket.rs`
- `client/src/services/gameSocket.ts`
