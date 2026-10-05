# CS2 Inventory Worker API

[CS2 Inventory Simulator](https://github.com/cyqmq/cs2-inventory-Frontend) 后端 API 的 **Cloudflare Workers 重构版**（纯 JSON API）。

保留了原 [cs2-inventory-serverapi](https://github.com/cyqmq/cs2-inventory-serverapi) 的全部 API 合约端点，但把 Express + Prisma + PostgreSQL 替换为：

- **Hono 4** — 路由 / 中间件（轻量，适合 Workers 冷启动）
- **Kysely** — 类型安全查询层，一套查询代码同时支持两种存储：
  - **D1 (SQLite)** — Workers 免费版常用，零维护
  - **Hyperdrive + PostgreSQL** — 需要外置 PG（付费托管或自建）
- **Zod 4** — 请求参数校验（与原版 `zod` schema 对齐）
- **`@ianlucas/cs2-lib`** — 经济数据与库存逻辑（与原版同一库）

## 目录

- [快速开始（本地开发）](#快速开始本地开发)
- [环境变量](#环境变量)
- [部署](#部署)
- [API 端点](#api-端点)
- [与前端 / Electron 集成](#与前端--electron-集成)
- [已知取舍与注意点](#已知取舍与注意点)
- [脚本](#脚本)
- [目录结构](#目录结构)

## 快速开始（本地开发）

前置：**Node.js >= 20**。

```bash
# 1. 安装依赖
npm install

# 2. 创建本地环境变量
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，至少填写 SESSION_SECRET 与 ELECTRON_AUTH_SECRET

# 3. 创建本地 D1 数据库并应用迁移 + 内置规则
npm run db:migrate:d1:local
npm run db:seed:rules:d1:local

# 4. 启动（默认 8787 端口）
npm run dev
```

启动后 `GET http://localhost:8787/healthz` 应返回 `Supposedly healthy`。

本地 HTTP 开发环境请把 `.dev.vars` 里的 `SESSION_SECURE_COOKIE` 设为 `false`，
否则带 `Secure` 标记的 session cookie 会被浏览器拒收（详见[会话 Cookies](#会话-cookies)）。

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `SESSION_SECRET` | ✅ | 签名 `_session` cookie（HMAC-SHA256）。用 `crypto.randomUUID() + crypto.randomUUID()` 生成 |
| `ELECTRON_AUTH_SECRET` | ✅ | 与 Electron 客户端约定的认证密钥 |
| `STEAM_API_KEY` | ❌ | Steam Web API 密钥（可用规则 `steamApiKey` 覆盖；Steam 登录需要真实 key） |
| `STEAM_CALLBACK_URL` | ❌ | Steam OpenID 回调地址，默认 `http://localhost:8787/sign-in/steam/callback` |
| `FRONTEND_URL` | ❌ | 前端 origin。设置后登录/偏好等回调 302 跳转到这里，并参与 CORS 白名单；未设置时跳回 `/` |
| `CORS_ORIGINS` | ❌ | 逗号分隔的额外 CORS 允许 origin（超出 `FRONTEND_URL`） |
| `TRUSTED_HOSTNAMES` | ❌ | 逗号分隔的可信 hostname（3D viewer origin 校验）。**注意：`localhost` / `127.0.0.1` 不再由它控制**，见 `TRUST_LOCALHOST_ORIGINS` |
| `TRUST_LOCALHOST_ORIGINS` | ❌ | 是否信任 `localhost` / `127.0.0.1` 的 CORS origin。`true` 无条件信任；`false` 永不信任；**未设置时只有 `FRONTEND_URL` 与 `CORS_ORIGINS` 都为空（纯本地 `wrangler dev`）才信任**。反射 loopback origin 会同时发 `Allow-Credentials: true`，等于让任何能在本机起 loopback 端口的进程带 cookie 读 API，所以部署环境默认收紧 |
| `VIEWER_EMBED_URL` | ❌ | 3D 查看器嵌入地址，默认 `https://3d.cstrike.app/view` |
| `VIEWER_ASSETS_BASE_URL` / `VIEWER_KEY` | ❌ | 查看器资源 CDN / API key |
| `ASSETS_BASE_URL` | ❌ | 物品图片等静态资源 CDN 前缀 |
| `CLOUDFLARE_ANALYTICS_TOKEN` | ❌ | Cloudflare Analytics beacon token |
| `SOURCE_COMMIT` | ❌ | 构建 commit，经 `/api/init` 的 `sourceCommit` 上报 |
| `SESSION_SECURE_COOKIE` | ❌ | `false` 时 session cookie 不带 `Secure`（本地 HTTP 用） |
| `SESSION_COOKIE_SAMESITE` | ❌ | 覆盖 session cookie 的 SameSite（默认 `Lax`） |
| `DATABASE_URL` | PG only | 仅 `scripts/`（`apply-migrations-pg.ts`、`seed-rules.ts`）在 PG 部署时使用 |

> 秘密变量（key/token/session 密钥）放 `.dev.vars`（本地）或 Cloudflare Dashboard → Worker → Settings → Variables
> / `wrangler secret put`（生产）。`wrangler.jsonc` 里只有非敏感的 `SOURCE_COMMIT`。

`steamCallbackUrl`、`steamApiKey`、`viewerKey` 三个规则走 env 回退，`seed-rules` 会**跳过**它们——
在 `Rule` 表里插一条会遮蔽 env 值，与原版行为保持一致。

## 部署

### 方案 A：D1（免费版，推荐）

```bash
# 1. 创建数据库（一次性）
npx wrangler d1 create cs2-inventory-db

# 2. 把返回的 database_id 填进 wrangler.jsonc 的 d1_databases[].database_id

# 3. 应用到远程
npm run db:migrate:d1:remote
npm run db:seed:rules:d1:remote

# 4. 配置生产秘密
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ELECTRON_AUTH_SECRET
# （STEAM_API_KEY / FRONTEND_URL / CORS_ORIGINS 等可放 Dashboard 变量或真 secrets）

# 5. 部署
npm run deploy
```

### 方案 B：Hyperdrive + PostgreSQL（付费 / 外置库）

```bash
# 1. 建 Hyperdrive（指向已有 PG）
npx wrangler hyperdrive create cs2-inventory-hyperdrive --connection-string="$DATABASE_URL"

# 2. 把返回的 hyperdrive id 填进 wrangler.jsonc（注释掉的 hyperdrive 块），并删除 d1_databases 块

# 3. 建表 + 种子规则
#    （需要本地能连 PG，DATABASE_URL 指向同一实例）
npm run db:migrate:pg
npm run db:seed:rules > seed.sql && psql "$DATABASE_URL" -f seed.sql

# 4. 部署
npm run deploy
```

> `DB` binding 存在时用 D1；缺 `DB` 而有 `HYPERDRIVE` 时用 PostgreSQL。见 `src/db/database.ts`。

> ⚠️ **两个方案的迁移都必须先于部署跑完**。当前 schema 到 `0003_session.sql`：
> - `0002` 建 `RateLimitBucket`——不跑的话公开模式 spray/stattrak 和所有端点限流都会 500；
> - `0003` 建 `Session`——不跑的话每个请求的会话存活校验会去查一张不存在的表，
>   **线上所有已登录 session 立刻集体失效**。

两套库共用同一张表结构（原始 Prisma 的 PascalCase 表名），`migrations/` 与 `migrations-pg/` 是同一
schema 的 SQLite / PostgreSQL 两个方言版本。

## API 端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/healthz` | — | 健康检查（返回 `Supposedly healthy`） |
| GET | `/api/init` | Cookie* | 客户端初始化数据（rules / preferences / user），含 `rules.viewer`（服务端 3D viewer 判定） |
| POST | `/api/sign-in` | — | API Key 登录，失败/空 body 返回 400。限流 30/min/客户端分片 |
| GET | `/sign-out` | — | 登出：盖 `Session.revokedAt`（真正吊销）+ 用过期 cookie 覆盖 `_session`，302 → `FRONTEND_URL`/`/` |
| GET | `/api/sign-in/callback` | — | Steam OAuth 回调（带 `id_res`/`code`）。限流 30/min/客户端分片 |
| GET | `/sign-in/steam/callback` | — | Steam OpenID 回调入口（无参请求返回 302 跳转 Steam） |
| GET | `/api/auth/electron` | ELECTRON_AUTH_SECRET | Electron 无头登录，返回 session cookie。限流 10/min/客户端分片 |
| GET | `/api/auth/electron-config` | ELECTRON_AUTH_SECRET | Electron 获取配置；无 secret 返回 400 |
| POST | `/api/action/sync` | Session | 同步库存（增量动作列表，见 [sync 协议](#sync-协议)） |
| GET | `/api/action/resync` | Session | 重新同步（返回最新 `syncedAt` + 库存 JSON） |
| GET/POST | `/api/action/reset-inventory` | Session | 重置库存（302 → `FRONTEND_URL`/`/`）。**GET/POST 都收**，两者都过 `assertSameOrigin()`（`Sec-Fetch-Site: cross-site` 或跨 origin → 403）；PUT/DELETE/PATCH → 405 |
| POST | `/api/action/unlock-case` | Session | 开箱（需要 `keyUid`，见[开箱](#开箱)） |
| POST | `/api/action/import-inspect-link` | Session | 导入检视链接。限流 1/s/用户（持久化桶） |
| GET/POST | `/api/action/preferences` | Session | 偏好表单（GET/POST 均 302 + Set-Cookie 写会话） |
| GET | `/api/users` | API Key | 用户列表。限流 60/min/api key |
| GET | `/api/user/basic/:userId` | — | 公开；`{ avatar, name }`，用户不存在返回 `null`。限流 60/min/客户端分片 |
| GET | `/api/user/:userId` | API Key | 获取单个用户。限流 60/min/api key |
| POST | `/api/add-item` | API Key | 给用户库存加一件物品（204） |
| POST | `/api/add-container` | API Key | 给用户库存加一个随机容器（返回容器 JSON） |
| POST | `/api/increment-item-stattrak` | API Key 或公开规则 | StatTrak 计数 +1（204）；apiKey 可选，无 key 时需 `apiPublicStatTrakIncrement=true` + 令牌桶（50 容量/每 3.6s 回 1，超限 429），且物品须已装备 |
| POST | `/api/consume-item-spray` | API Key 或公开规则 | 消耗已装备涂鸦 1 次充能（204）；无 key 时需 `apiPublicSprayConsume=true` + 令牌桶（1 容量/每 30s 回 1，超限 429），且物品须是涂鸦且已装备 |
| GET | `/api/inventory/:userId.json` | — | 公开库存 JSON（用户不存在返回 200 `{}`） |
| GET | `/api/equipped/v4/:userId.json` | — | 已装备 v4 JSON |
| GET | `/api/equipped/v5/:userId.json` | — | 已装备 v5 JSON |

\* `/api/init` 带 cookie 时返回登录用户，否则返回 `user: undefined`。所有请求都会
`touchLastSeen`（非公开端点），方法不对统一 405。

### sync 协议

`POST /api/action/sync` 请求体：

```jsonc
{
  "syncedAt": 1790661913918,   // 客户端当前已知的 syncedAt
  "actions": [
    { "type": "add", "item": { "id": 37 } }
    // ... 详见 src/routes/actions.ts 的 actionShape（add / add-from-cache /
    // add-with-nametag / apply-item-patch / apply-item-sticker / equip /
    // unequip / rename-item / remove / ... / edit / add-with-sticker /
    // remove-all-items）
  ]
}
```

返回 `{ "syncedAt": <新的值> }`。

- `syncedAt` 不匹配服务端当前值 → **409**（并发守卫）。每次成功 sync 后必须用返回的
  新 `syncedAt` 续传；`resync`、`reset-inventory` 等外部操作会推进 syncedAt，客户端要重新拉取。
- 免费物品（id 0–36 的默认武器，以及少数道具如 58/59/1779 等，`free: true`）必须附带
  nametag / stickers / keychains 等才有实际属性，纯 `{id}` 的免费物品会被原版 shapes
  校验拒绝——这是与之一致的预期行为（经济物品 id 从 37 起）。

### 开箱

`POST /api/action/unlock-case`：

```jsonc
{ "caseUid": 0, "keyUid": 1, "syncedAt": 1790661913918 }
```

- `cs2-lib` 会校验容器与钥匙（`validateContainerAndKey`）：**需要钥匙的容器必须传
  `keyUid`**，否则 500。前端会先让用户装备钥匙（`equip`）+ 库存里加入对应钥匙物品。
- 成功返回 `{ unlockedItem, syncedAt }`（`unlockedItem` 与原版结构一致，含 `containerId` /
  `seed` / `wear` / `statTrak` 等属性）。

## 与前端 / Electron 集成

前端（`cs2-inventory-Frontend`）需要指到本 API：

- **Electron**：在设置页填 API 地址（如 `http://localhost:8787`），用 `/api/auth/electron`
  登录。
- **浏览器（Web）**：保证前端 origin 在 `FRONTEND_URL` 或 `CORS_ORIGINS` 白名单内，或构建时
  通过 `API_BASE_URL` 注入。浏览器模式下前端以同源 origin 作为 API 地址，所以**生产环境需要
  反代 `/api`、`/sign-in`、`/healthz` 到 Worker**；本地开发接 Worker 则靠 Vite 代理
  （`vite.config.ts` 的 `proxy`，默认转发到 `http://localhost:8787`，可用 `WORKER_URL` 覆盖）。

### 会话 Cookies

- Cookie 格式：`_session=<b64url(JSON payload)>.<b64url(HMAC-SHA256)签名)>`，
  `HttpOnly`、`Path=/`、`SameSite=Lax`（可覆盖）、`Secure`（除非
  `SESSION_SECURE_COOKIE=false`）、`Max-Age` 接近永久（≈68 年）。
- **服务端有会话表，可以吊销**（迁移 `0003`，见 `src/lib/session-store.ts`）：
  - payload 里带一个登录时铸造的 `sid`，因为 payload 有签名，客户端**伪造不了也换不了** `sid`；
  - `getUserIdFromRequest` 每个请求校验 `sid` 是否存活。未知 / 已吊销 / 已过期一律 401；
  - `/sign-out` 给该 `sid` 打 `revokedAt`，**下一个请求立刻失效**——不再依赖浏览器何时
    肯配合删 cookie；
  - 服务端硬过期 `SESSION_TTL_MS` = **30 天**。cookie 自己的 `Max-Age` 只是兼容保留，
    真正的上限是表里的 `expiresAt`，客户端改不动。
  - 登录不复用 `sid`：同一账号在第二台设备登录会插入**新行**，所以在 B 设备登出不会把
    A 设备踢下线（登出是按 `sid` 精确吊销的）。
- **与旧版（Express/Express-session 服务端 session）不兼容**：签名方案不同，
  升级后所有用户需要重新登录。
- ⚠️ **`0003` 迁移必须先跑**：远程库没建 `Session` 表之前，`getUserIdFromRequest` 的存活
  校验会查一张不存在的表 → **所有已登录 session 全部失效**（不是 500，是集体登出）。
  D1 用 `npm run db:migrate:d1:remote`，PG 用 `npm run db:migrate:pg`。
- `SESSION_SECURE_COOKIE=true`（默认）时 cookie 带 `Secure`，**本地 HTTP（`wrangler dev`）下
  浏览器会拒收**——本地开发请设为 `false`，生产 HTTPS 保持 `true`。

### 速率限制

限流**全部走数据库**（`RateLimitBucket` 表，迁移 `0002`），不是进程内存 Map——Worker isolate
数量多且随时会被回收，内存 Map 的限流等于没有。

| 端点 | 配额 | 桶键 |
|------|------|------|
| `/api/sign-in` | 30/min | 客户端分片 |
| `/api/sign-in/callback` | 30/min | 客户端分片 |
| `/api/auth/electron` | 10/min | 客户端分片 |
| `/api/users` | 60/min | api key（SHA-256 截断） |
| `/api/user/:userId` | 60/min | api key（SHA-256 截断） |
| `/api/user/basic/:userId` | 60/min | 客户端分片 |
| `/api/action/import-inspect-link` | 1/s | 用户 |
| `/api/consume-item-spray`（公开模式） | 1/30s | `spray:{userId}:{uid}` |
| `/api/increment-item-stattrak`（公开模式） | 50/3.6s | `stattrak:{userId}:{uid}` |

**桶键必须有界**（`src/lib/rate-limit-key.ts`），这是硬约束，不是风格问题：桶是真实数据行，
任何派生自请求元数据的键都是攻击者可控的，否则 N 个请求就能插 N 行——正是本仓库修过的一个
存储 DoS。所以只有两种键来源：

1. **凭据派生**——基数被现存凭据数量封顶。api key 走 SHA-256 截断，不存明文，
   免得 `RateLimitBucket` 的备份变成一份可用凭据清单。
2. **客户端 IP 分片**（256 片）——用于完全无需凭据的端点。伪造 `X-Forwarded-For` 只能挑到
   一个**已经存在**的分片。

代价是真实的：同分片的两个无关客户端共享配额，攻击者可以稀释正常用户的预算。但这仍然比
"单个全局桶"好——后者能让一个攻击者把所有用户一起锁死。

429 响应**没有 body**（`tooManyRequests = new Response(null, { status: 429 })`），与上游
`responses.server.ts` 一致；前端按状态码映射文案（`craft-import-inspect-link.tsx:21`）。

过期桶（`updatedAt` 超过 24h，此时它早已回满，删掉不可能多给配额）每 5 分钟最多清一次、
每批 500 行，**await 而不是 detached**——留在响应之后的 promise 会一直占着 D1 写锁，
把同 isolate 后续请求全堵死，表现就是无关端点莫名其妙地卡住。

### CORS

- 白名单 = `FRONTEND_URL` + `CORS_ORIGINS`（精确 origin，去尾斜杠）+ `TRUSTED_HOSTNAMES`
  （hostname 子域匹配）。**`localhost` / `127.0.0.1` 改由 `TRUST_LOCALHOST_ORIGINS` 控制**
  （默认：仅当没配任何前端 origin 时信任），不再是恒放行。
- 允许方法 `GET, POST, OPTIONS`，允许头 `Content-Type, Authorization`，支持凭据
  （`Access-Control-Allow-Credentials: true`）。
- 注意：Hono 4.13 的 `compose()` 只把 `Error` 实例交给 `onError`，`throw <Response>`
  会逃逸成 500——本仓库在 CORS 中间件用 try/catch 拦截 `error instanceof Response`
  再返回，保证 400/405/302 行为正确且错误响应也带 CORS 头（见 `src/index.ts`）。

## 已知取舍与注意点

### Workers 免费版 10ms CPU/天

免费版 Worker 每天约 10ms CPU 预算，本仓库按这个约束设计：

- 查询层为轻量 Kysely，D1 单写原子更新（`src/models/manipulate-user-inventory` 一次性读改写）
- 经济数据在首次请求时同步加载进 `CS2Economy`（模块级缓存），不逐请求读库
- 全部动态路由参数用真实输入，无需正则回绕

### 3D viewer 探测用惰性 TTL 而不是常驻循环

上游 `app/data/viewer.server.ts` 用两个自调度 `setTimeout` 循环保温 viewer 的 catalog 与公开配额，
并逐请求读缓存。Worker isolate 不能在请求之间持有定时器，因此 `src/lib/viewer.ts` 改成**模块级惰性
TTL 状态机**：首次请求限时等待（catalog 1.5s）后返回，过期时 stale-while-revalidate 后台刷新。
`reason` 名称、优先级顺序与 fail-closed 语义与上游一致；差异只在于冷启动后的第一个请求可能拿到
`pending`，而不会像上游那样一直阻塞到探测成功。

### ⚠️ SQL 必须同时在 SQLite 和 PostgreSQL 上成立

D1 和 PostgreSQL 只共享**很小**一个 SQL 子集，而且分歧点往往在最顺手的地方。踩过的坑：

**双参数标量 `MIN()`**。SQLite 有 `min(X, Y)` 标量形式，于是
`MIN(tokens + refill, capacity)` 在本地 D1 上跑得好好的。但 PostgreSQL 的 `min()` 是
**只接受一个参数的聚合函数**，`min(double precision, integer)` 根本不存在，也没有任何
隐式转换路径能让它成立：

```
function min(double precision, integer) does not exist
```

结果是**每个限流请求在 Hyperdrive/Aiven 上必然 500**——而本地 D1 测试永远发现不了。
`LEAST()` 是 PG 的答案但 SQLite 没有，`GREATEST()` 镜像问题同样存在。唯一两边都在的写法是
`CASE WHEN ... > cap THEN cap ELSE ... END`（见 `token-bucket.ts` 的 `clampToCapacity`）。

**教训**：验证脚本不要再手抄一份 SQL。`scripts/verify-token-bucket.ts` 现在直接从
`src/lib/token-bucket.ts` 导入 `buildInsertBucket` / `buildConsumeToken` /
`buildPruneSelect` / `buildPruneDelete`——手抄的副本当时还在测**已经被替换掉的 `MIN`**，
正是这种漂移让 PG bug 溜过了评审。

**`DELETE ... LIMIT`**：SQLite 里是编译期选项，PostgreSQL 直接语法错误。两处分批删除
（`pruneExpiredBuckets`、`sweepSessions`）都改成"先 SELECT 出 key，再 `WHERE key IN (...)`"。

**`LIKE` 的默认转义符**：SQLite 没有，PG 默认是 backslash。`users.ts` 显式写
`ESCAPE '\'`，否则同一个查询在两个后端上通配符集合不一样。

### 语言回退为英文（`add-container`）

原版用 `serverGlobals`（全部语言）返回容器名；Workers bundle 体积受限，本仓库只打包英文，
`POST /api/add-container` 的 `language` 参数**总是返回英文名**。前端拿到 id 后自行本地化，
行为不受影响。

### 3MB gzip 预算（前端构建侧）

Workers 单脚本主包限额约 3MB（gzip）。若把前端逻辑合入此 Worker 会导致超限，因此前端保持
独立构建（资源分块按需加载，见前端仓库的 `scripts/check-gzip.cjs`），本仓库保持纯 API。

## 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | `wrangler dev`（本地起在 8787） |
| `npm run deploy` | 部署到 Cloudflare（`predeploy` 会自动重新生成经济数据） |
| `npm run typecheck` | 主代码类型检查 |
| `npm run typecheck:scripts` | scripts/ 类型检查 |
| `npm run build:data` | 从 `@ianlucas/cs2-lib` 生成 `src/data/items.ts`（约 1.5 万条经济数据） |
| `npm run build:size` | `wrangler deploy --dry-run` 输出最终 bundle 体积 |
| `npm run db:migrate:d1:local` / `:remote` | 应用 D1 迁移 |
| `npm run db:migrate:pg` | 应用 PostgreSQL 迁移 |
| `npm run db:seed:rules` | 打印规则种子 SQL（PG 用） |
| `npm run db:seed:rules:d1:local` / `:remote` | 直接 seed 到 D1 |

离线断言（不需要 `wrangler dev`）：

| 命令 | 说明 |
|------|------|
| `npx tsx scripts/verify-v9-migration.ts` | 库存 v1→v2 迁移（6 断言） |
| `npx tsx scripts/verify-token-bucket.ts` | 令牌桶 SQL + prune（22 断言）。**直接 import `token-bucket.ts` 里真正上线的那几个 builder**，不手抄副本 |

冒烟脚本（开发期用，需要 `wrangler dev` 在 8787 运行且已造好测试 session）：

- `scripts/smoke-spray-stattrak.mjs` — spray / stattrak 公开模式与令牌桶（19 断言）
- `scripts/smoke-extra-actions.mjs` — 贴纸板/挂件包/钥匙扣等剩余 action（16 断言）
- `scripts/smoke-sync.cjs` — sync 协议冒烟（空 sync、Add、批量 Add、409 守卫）
- `scripts/smoke-actions.cjs` — 完整动作链路（resync、reset-inventory、preferences、
  容器+钥匙同步、unlock-case、equipped v5）

> 脚本认 `SMOKE_BASE` 环境变量（默认 `http://127.0.0.1:8787`）。
>
> ⚠️ 不要在 `wrangler dev` 运行时并行跑 `wrangler d1 execute --local`——两者抢同一个
> `.wrangler/state`，会把 workerd 打成 crash。需要查库就先停 dev。

## 目录结构

```
src/
├── index.ts                 Hono 入口：CORS 中间件、路由注册、404/onError
├── env.ts                   Env 接口 + 请求级 setRuntime/getRuntime
├── auth.ts                  会话 cookie 校验（含 Session 表存活校验）/ 用户提取
├── middleware.ts            请求中间件（尾斜杠/尾点、economy 加载、库存迁移、touchLastSeen）
├── db/                      Kysely 实例（D1 / Hyperdrive 自动切换）+ 表类型
├── models/                  user / rule / user-preference / user-cache / api-credential / migrate-inventory
├── lib/                     shapes（zod）、economy-loader、responses、redirect、session、
│                            session-store（吊销/过期）、token-bucket（持久化限流）、
│                            rate-limit-key（有界桶键）、equipped-v4/v5、csfloat
├── preferences/             language / background 解析
├── routes/                  actions / add-container / add-item / electron / healthz /
│                            increment-item-stattrak / init / inventory / preferences /
│                            sign-in / sign-out / steam-callback / user / users
└── data/                    items.ts（generate-economy-data.ts 生成）
migrations/                   D1 (SQLite) schema —— 0002 限流桶 / 0003 Session
migrations-pg/               PostgreSQL 同一 schema（不同方言）
scripts/                     generate-economy-data / apply-migrations-pg / seed-rules /
                             verify-*（离线断言）/ smoke-*
```

> `migrations/` 与 `migrations-pg/` 是同一 schema 的两个方言版本，**改一处必须同步另一处**。

## 技术栈

- **运行时**：Cloudflare Workers（`nodejs_compat`）
- **框架**：Hono 4
- **查询**：Kysely + kysely-d1 / kysely-postgres-js
- **存储**：D1 (SQLite) 或 Hyperdrive + PostgreSQL
- **经济/库存**：`@ianlucas/cs2-lib` + `@ianlucas/cs2-lib-inspect`
- **校验**：Zod 4
- **语言**：TypeScript 5