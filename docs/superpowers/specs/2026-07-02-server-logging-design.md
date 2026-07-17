# Server 层日志系统设计

> 本文档为 2026-07-02 设计决策记录。

## 背景

Loom server 层目前没有持久化日志。现有日志全部是散落的 `console.log/error/warn`，分布在 `index.ts`、`api/server.ts`、`api/routes.ts`、`api/deps.ts` 等文件中。`hono/logger` 中间件只把 HTTP 请求打到 stdout，不落盘。`ProjectionDeps.logger` 接口（error/warn）也只是转发到 console。

问题：运行中的报错、未捕获异常、关键流程信息没有任何持久化记录，排障困难。

## 目标

- 为 server 层引入持久化日志，写入文件
- 记录所有重要流程的关键信息和所有报错（含完整调用栈）
- 捕获运行中未处理的异常（uncaughtException / unhandledRejection）
- 日志文件按天轮转，保留最近 7 天
- 人类可读的行格式，非结构化 JSON

## 格式

```
2026-07-02 09:59:10 INFO  loom.api - sync pull completed repoPath=/home/user/.loom/repos/default duration=120ms
2026-07-02 10:00:05 ERROR loom.sync - pull failed err=Error: no remote repoPath=/home/user/.loom/repos/default
  Error: no remote
      at syncPull (.../sync/pull.ts:45:11)
      at ...
```

要素：

- 时间戳：`YYYY-MM-DD HH:mm:ss`，本地时区
- 级别：`DEBUG / INFO / WARN / ERROR`，固定 5 字符宽度左对齐
- 组件名：通过 child logger 标注，如 `loom.api`、`loom.sync`、`loom.projection`
- 消息：人类可读的简短描述
- 上下文：`key=value` 对，空格分隔，值为字符串/数字/布尔时直出，含空格或特殊字符时加双引号
- 错误栈：ERROR 级别且上下文含 `err` 字段（Error 实例）时，消息后换行缩进输出完整 stack

## 配置

| 环境变量         | 默认值          | 说明         |
| ---------------- | --------------- | ------------ |
| `LOOM_LOG_DIR`   | `<项目根>/logs` | 日志文件目录 |
| `LOOM_LOG_LEVEL` | `INFO`          | 最低输出级别 |

## 轮转与清理

- 文件名：`loom-YYYY-MM-DD.log`，每天一个文件
- 按天轮转：每次写入前检查当前日期，与当前打开的文件日期不符时切换新文件
- 启动时清理：删除 7 天前的日志文件
- 无需外部进程，logger 自身管理轮转

## 架构

### 核心模块：`packages/server/src/lib/logger.ts`

零额外依赖，纯 Node.js `fs` 实现。

```typescript
interface Logger {
  debug(msg: string, ctx?: LogContext): void
  info(msg: string, ctx?: LogContext): void
  warn(msg: string, ctx?: LogContext): void
  error(msg: string, ctx?: LogContext): void
  child(component: string): Logger
}

type LogContext = Record<string, unknown>
```

内部实现要点：

- `createLogger(opts)` 工厂函数，返回 Logger 实例
- 写入方式：`fs.appendFile`（异步，每条日志一次写入；Loom 是低并发的本地工具，无需批量缓冲）
- 双写：同时写入文件和控制台（stderr），格式一致
- 级别过滤：低于配置级别的不输出
- 错误栈提取：检测 `ctx.err` 为 Error 实例时，追加 `\n  ` + `err.stack`
- 单例：导出默认 logger 实例 `logger`，组件名为 `loom`

### 接入点

**1. HTTP 请求日志（`api/server.ts`）**

移除 `hono/logger`，替换为自定义中间件：

```typescript
app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  requestLogger.info('request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration: `${duration}ms`,
  })
})
```

`requestLogger` 为 `logger.child('loom.api')`。

**2. 业务流程日志（`api/routes.ts`）**

各路由 handler 在关键操作前后记录 INFO：

- `sync/pull`：开始拉取、拉取完成/失败
- `sync/push`：开始推送、推送完成/失败
- `sync/apply`：应用冲突解决方案
- `project`：投影开始、投影完成/失败
- `install`：安装 skill 源
- `update`：检查更新、执行更新
- 各 catch 块：用 `logger.error` 记录错误对象 + 调用栈

现有散落的 `console.error/warn` 全部替换为对应级别的 logger 调用。

**3. 现有 Logger 接口桥接（`api/deps.ts`）**

`ProjectionDeps.logger` 和 `sync/pull.ts` 中的 `Logger` 类型保持 `(obj, msg) => void` 签名不变，在 `createDeps` 中桥接到新 logger：

```typescript
logger: {
  error: (o, m) => projectionLogger.error(m, o),
  warn: (o, m) => projectionLogger.warn(m, o),
},
```

`projectionLogger` 为 `logger.child('loom.projection')`。

**4. 全局未捕获异常（`index.ts`）**

```typescript
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { err })
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { err: reason })
  process.exit(1)
})
```

## 测试

`packages/server/src/lib/logger.test.ts`，用 vitest + 临时目录：

- **格式验证**：各级别输出格式正确，时间戳/级别/组件名/消息/key=value 对齐
- **错误栈**：传入 Error 实例时，输出包含完整 stack
- **级别过滤**：设置 `LOOM_LOG_LEVEL=ERROR` 时，DEBUG/INFO/WARN 不输出
- **轮转**：模拟跨天写入，产生不同日期的文件
- **清理**：构造 7 天前的日志文件，启动后验证被删除，近 7 天的保留
- **child logger**：子 logger 的组件名正确拼接

## 文件变更清单

| 文件                                         | 变更                                               |
| -------------------------------------------- | -------------------------------------------------- |
| `packages/server/src/lib/logger.ts`          | 新增：核心 logger 模块                             |
| `packages/server/src/lib/logger.test.ts`     | 新增：测试                                         |
| `packages/server/src/index.ts`               | 修改：注册全局异常处理                             |
| `packages/server/src/api/server.ts`          | 修改：移除 hono/logger，替换为自定义请求日志中间件 |
| `packages/server/src/api/routes.ts`          | 修改：各 handler 加业务日志，catch 块替换 console  |
| `packages/server/src/api/deps.ts`            | 修改：logger 桥接到新 logger                       |
| `packages/server/src/projection/executor.ts` | 无需改动（接口不变）                               |
| `packages/server/src/sync/pull.ts`           | 无需改动（接口不变）                               |
| `.gitignore`                                 | 修改：添加 `logs/`                                 |

## 不做的事

- 不引入 pino/winston 等外部日志库
- 不做日志聚合、远程上报
- 不做日志压缩归档（7 天外直接删除）
- 不做请求 ID 链路追踪（YAGNI，Loom 是本地工具）
- 不改 `ProjectionDeps.logger` 接口签名（保持调用方零改动）
