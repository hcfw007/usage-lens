# usage-lens

一个读取 cc-switch 本地数据库的零依赖用量分析工具。

## 为什么做这个工具

部分模型服务或中转不会提供缓存读写用量。于是，同样的长上下文请求：

- 经过会报告缓存的渠道，重复命中的上下文会计入 `cache_read`；
- 经过这个中转，缓存字段是 0，上下文则看起来都像普通 `input`。

cc-switch 默认把 input、output、缓存读和缓存写相加显示。缓存字段缺失时，这个总量会显得更少；
而本地费用估算也可能把本可按缓存价计算的上下文按普通输入价估算，显得更贵。只看单一总量，
就很难分辨是工作量变化，还是中转的缓存上报方式不同。

Usage Lens 并列展示多个 token 口径、排除缓存未上报记录后的命中率，并标出缓存数据缺失的行，
帮助区分实际输入/输出、缓存复用和上报差异。它不会补造中转没有返回的缓存数据，也不替代上游账单。

## 背景：为什么要多口径

cc-switch 的默认 token 统计 = 输入 + 输出 + 缓存读 + 缓存写。能报告缓存的渠道会把缓存读计入总量；
不报告缓存的渠道则可能把这些 token 记作普通输入。因此跨渠道直接比较默认总量，会受到缓存上报差异影响。

## 安装

```bash
npm link        # 可选：注册 ulens 全局命令
# 或直接 node bin/cli.js
```

要求 Node >= 22.5（使用内置 node:sqlite，无第三方依赖）。

## HTML 报告

```bash
ulens html                    # 最近 30 天，写入 ./cc-usage-report.html
ulens html --out ~/usage.html
```

生成单个自包含 HTML（数据内嵌，无外部请求），双击即可打开。页面内可切换近 7 / 14 / 30 天
或自选起止日期（限定在快照的 30 天内）、切换统计口径；当前视图会写进 URL hash，可收藏。

### 实时本地页面

```bash
ulens serve                 # 自动打开 http://127.0.0.1:4782，每分钟自动刷新，也可手动刷新
ulens serve --db /path/to/cc-switch.db
```

项目中的 HTML 是不含用量数据的模板，数据仅由同源的本机后端读取并返回给本机浏览器。
服务只监听回环地址 `127.0.0.1`；不会将数据库或用量数据上传到 GitHub 或其他服务器。
每次手动刷新或每分钟自动刷新时，后端都会重新读取 cc-switch 数据库。

### cc-switch 数据库位置

默认自动查找 `~/.cc-switch/cc-switch.db`，并探测常见配置目录。可通过以下任一方式指定：

```bash
ulens serve --db /完整路径/cc-switch.db   # 单次指定，优先级最高
export CC_SWITCH_DB=/完整路径/cc-switch.db
export CC_SWITCH_HOME=/完整路径/.cc-switch # 目录，程序会追加 cc-switch.db
```

## 用法

```bash
ulens [dimension] [options]

# 最近 8 天按天
ulens day --from 2026-10-08

# 按模型，按「去缓存 token」排序
ulens model --from 2026-10-13 --metric fresh

# 按 opencode 会话（带标题），看钱花在哪
ulens session --from 2026-10-13 --metric cost --limit 10
```

### 维度

| 维度 | 含义 |
|---|---|
| `day` | 按天（默认） |
| `model` | 按模型 |
| `app` | 按应用（claude / opencode / codex ...） |
| `session` | 按 opencode 会话，自动关联会话标题 |
| `day+model` | 天 × 模型 |
| `day+app` | 天 × 应用 |

### 列（口径）

| 列 | 公式 | 回答的问题 |
|---|---|---|
| `real` | in + out + cacheRead + cacheCreate | cc-switch UI 的口径 |
| `fresh` | in + out | 真正进出模型的新 token（去缓存幻影） |
| `context` | in + cacheRead | 上下文搬运量（背了多少上下文跑） |
| `output` | out | 生成量（工作量代理指标） |
| `cost` | 估算美元 | 本地定价折算，非上游账单 |

`extra` 列显示 cache 占比，便于一眼识别「缓存驱动」的日子。

## 数据来源

只读访问 `~/.cc-switch/cc-switch.db`，自动合并两个存储时代：

- `proxy_request_logs`（2026-09-16 起，请求级明细，含 session_id）
- `usage_daily_rollups`（2026-09-15 及以前，天级汇总）

session 维度额外只读访问 `~/.local/share/opencode/opencode.db` 关联标题，
失败时静默降级。数据库被 cc-switch 写锁占用时自动快照到临时目录再读。
