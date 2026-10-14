# YT 语镜 · YouTube → 中文对话文章

输入一段带字幕的 YouTube 视频链接，基于字幕调用 **Gemini 免费 API** 流式生成一篇排版清晰的中文对话解读文章，支持章节级 **5W1H 剖析**。部署于 Cloudflare Worker（含 Durable Object），前端零框架单页。

> 在线体验：[部署地址待填写]

## 功能

- 🎬 输入 YouTube 链接 → 自动抓取字幕（主路径失败自动降级，全程可观测）
- ✍️ 流式生成：Gemini 输出一点渲染一点，SSE 实时推送，带呼吸光标
- 🧩 可选**自然语言生成要求**：任务类型 / 输出风格 / 目标受众 / 约束条件
- 📑 文章按章节组织（`##` 标题），每个章节带 `[5W1H]` 按钮
- 🔍 **5W1H 总结**：结合整篇视频上下文 + 当前章节，服务端生成结构化 `{who, what, when, where, why, how}`
- 🛡️ 失败模式覆盖：YouTube 返回 `200 + 空 body`、验证码、限流等场景可分类降级并明确提示
- 🗑️ 会话 TTL：SessionDO 到期自动清理（Alarm），过期请求返回 `410 Gone`

## 效果示例

![生成的文章按章节组织，每章带 [5W1H] 按钮](docs/5w1h-1.png)

![点击 [5W1H] 弹出该章节的六维总结](docs/5w1h-2.png)

## 快速开始

### 1. 准备 Gemini API Key

到 [Google AI Studio](https://aistudio.google.com/) 免费申请 API Key。

### 2. 本地开发

```bash
npm install
# 配置本地密钥（本地开发）
cp .dev.vars.example .dev.vars   # 填入 GEMINI_API_KEY
npm run dev                      # 自动构建 + wrangler dev
```

浏览器打开 `http://127.0.0.1:8787` 即可体验。

### 3. 部署到 Cloudflare Worker

```bash
# 配置生产密钥
npx wrangler secret put GEMINI_API_KEY
# 部署（首次需 wrangler login）
npm run deploy
```

部署后获得 `https://<name>.<你的子域>.workers.dev` 公开网址。

### 可选：HTTP 代理（应对 YouTube 验证码/限流 + 受限网络访问 Gemini）

Cloudflare Worker 的 `fetch` 不支持代理，本项目用 **TCP Socket** 实现 HTTP CONNECT 隧道，分两组变量：

```bash
# ① Gemini 出口隧道：单代理（PROXY_* 命名 `proxy` 字段），流式/JSON 请求共用
npx wrangler secret put PROXY_HOST   # proxy.webshare.io
npx wrangler secret put PROXY_PORT   # 80 或 8080
npx wrangler secret put PROXY_USER   # 代理账号
npx wrangler secret put PROXY_PASS   # 代理密码

# ② 字幕出口代理池：逗号分隔 host:port[:user[:pass]]，顺序逐个尝试
npx wrangler secret put PROXY_LIST   # "1.2.3.4:80:user:pass,5.6.7.8:3128"
```

不配置时各模块零开销、不激活。

## 架构

```
浏览器单页 ──POST /api/article──▶ Worker（SSE 流式）
  │                                  ├─▶ YouTube：抓 watch 页动态指纹 → player → timedtext 字幕
  │                                  │     └─ 多 client 重试 / 代理池轮询 / 演示字幕降级
  │                                  ├─▶ Gemini streamGenerateContent?alt=sse（配置代理时走隧道）
  │                                  └─▶ SessionDO.save（TTL + Alarm 清理）
  │
  └──POST /api/sessions/:id/chapters/:n/5w1h──▶ SessionDO
       （请求不携带文章全文，服务端读取会话上下文 → Gemini JSON 模式 → 结构化 5W1H）
```

## 实现细节

### 1. YouTube 字幕获取（`src/lib/youtube.ts`）

分两阶段：**抓 watch 页提取动态会话指纹 → 调 player/timedtext 拿字幕**。

**阶段 1：抓 watch 页提取动态密钥**（比硬编码 key 新，抗风控关键）

```
GET watch?v=<id>&hl=en&persist_hl=1&bpctr=9999999999
 → 解析 INNERTUBE_API_KEY + VISITOR_DATA + INNERTUBE_CLIENT_VERSION
 → 提取 Set-Cookie 会话（SID/__Secure-*，socket 直连续信任）
 → consent 页重定向处理
```

**阶段 2：POST player + timedtext**

1. `POST /youtubei/v1/player?key=`（动态 key），body 带 client 上下文 + visitorData + Cookie
2. 从响应 `captionTracks[]` 选字幕轨（优先英文 ASR → 英文 → 中文 → 任意）
3. `GET timedtext?fmt=json3` 得到 JSON3，兼容 `ev.segs`（tStartMs）与 `ev.a[].segs`（t）两种结构，解析为 `[{time, text}]`

**有效载荷校验链路**（不只看 `response.ok`，覆盖 PoToken 等场景）：

```
HTTP 状态 → body 非空 → JSON 可解析 → playabilityStatus → captions 存在
→ captionTracks 非空 → timedtext body 非空 → 字幕段数 > 0
```

**降级顺序**：直连（ANDROID → WEB → IOS → TV）→ 代理池轮询（proxies × clients）→ 内置演示字幕。
每条失败路径记录 `fallbackReason`（`youtube_empty_body` / `youtube_no_caption_tracks` / `timedtext_empty_body` / `youtube_captcha` / `youtube_rate_limited` 等），前端琥珀色徽章明示。

**超时保护**：直连挂死（如无外网）10s 快速降级代理池；坏代理（不响应 CONNECT / TLS 卡死）15s 跳过——不拖慢整个代理池轮询。

### 2. TCP 代理隧道（`src/lib/proxy.ts`）

`fetch` 不支持代理，改用 `connect()`（`cloudflare:sockets`），提供三种能力：

```
TCP connect(代理) → CONNECT 目标:443 → 读 200 → startTls()（特性检测回退）
→ 手动 HTTP/1.1 请求 → 解析响应头与 body
```

- `httpsRequestViaProxy`：缓冲版（完整响应体，用于 Gemini JSON / 代理抓字幕）
- `httpsStreamViaProxy`：流式版（逐块读取响应体，用于 Gemini SSE 长流）
- `httpsRequestDirect`：直连 socket（不经代理，HTTP/1.1 + 完整浏览器头，对 Google 风控更友好）

三者的共性：必须传 `expectedServerHostname`（否则无 SNI，Google 会断连）。

### 3. Gemini（`src/lib/gemini.ts`）

- **流式**：`streamGenerateContent?alt=sse`（Gemini 原生 SSE），Worker 边读边转写为自定义 SSE，15s 定时 `: keep-alive` 防假死
- **非流式 JSON**：`generateContent` + `responseMimeType: application/json`（用于 5W1H 与要求解析），返回前剥离 markdown 围栏
- 两者都**按 `config.proxy` 决定走代理隧道还是直连**，本地/受限网络下保持一致出口
- 前端 `fetch` + `ReadableStream` + `TextDecoder` 逐块消费增量渲染
- 章节切分：流式检测 `## ` 标题行，实时推送 `chapter` 事件驱动前端挂载 `[5W1H]` 按钮
- 自然语言生成要求：`parseRequirements` 解析为结构化约束（失败降级为整段原文），再 `requirementsToPrompt` 合并进主文章 prompt

### 4. 请求链路（`src/index.ts`）

| 路径 | 处理 |
| --- | --- |
| `GET /`（非 /api/） | `ASSETS.fetch` 静态单页 |
| `POST /api/article` | 字幕 →（可选要求解析）→ Gemini 流式 → SSE 转发 + 章节切分 + 保存会话 |
| `POST /api/sessions/:id/chapters/:n/5w1h` | 转发 SessionDO，请求不携带文章全文 |

### 5. 章节 5W1H（`src/sessions.ts`）

**关键约束：请求不得携带整篇文章**。

- `SessionDO`（Durable Object）保存本次生成上下文 `{videoId, title, captions, requirements, article, chapters, createdAt, expiresAt}`（写入 DO Storage，非内存）
- 前端点 `[5W1H]` 只发 `POST /api/sessions/:id/chapters/:n/5w1h`（仅 sessionId + 章节号）
- DO 从存储读取整篇文章与当前章节，构造「整篇上下文 + 当前章节」prompt，调 Gemini 非流式 JSON 模式，返回固定 `{who, what, when, where, why, how}`
- 5W1H 请求同样遵循代理配置：配置了 `PROXY_*` 时走隧道，避免受限网络直连 Google 卡死
- **TTL 生命周期**：生成时写 `expiresAt = now + SESSION_TTL_SECONDS`（默认 24h），DO Alarm 到期幂等删除；读取时校验 `expiresAt`，即使 Alarm 延迟也不放行，返回 `410 Gone`

为什么用 DO 而非 KV：KV 单值 1MB 上限 + 最终一致；DO 单点强一致、适合存大上下文。

## 工程取舍与亮点

| 取舍 | 说明 |
| --- | --- |
| 抓 watch 页提取动态指纹 + 内部 JSON API | 动态 `INNERTUBE_API_KEY`/`VISITOR_DATA` 比硬编码 key 抗风控；字幕正文仍走 JSON API，易碎 HTML 只在首阶段解析 |
| 有效载荷校验显式建模失败模式 | `200 + 空 body` 不再被误判为成功，降级可观测 |
| 代理模块独立可选 | 无 `PROXY_*` 配置时零开销；`startTls` 特性检测保证兼容；直连/隧道均带超时保护 |
| 长流式放普通 Worker、上下文放 DO | 规避 DO CPU 事件限制，兼顾实时性与一致性 |
| SessionDO 带 TTL + Alarm 幂等清理 | 资源可回收，过期语义明确（410） |
| 前端零框架 + 手写轻量 Markdown 渲染 | 避免构建链膨胀，产物 < 13KB |


## 目录结构

```
youtube-article-ai/
├── public/               # 前端单页（index.html / app.js / style.css）
├── docs/                 # 文档配图（效果示例）
├── scripts/build.mjs     # esbuild 打包 Worker + 前端
├── src/
│   ├── index.ts          # Worker 入口：路由 + SSE 组装
│   ├── config.ts         # 环境变量规范化 + 代理列表解析
│   ├── sessions.ts       # SessionDO：TTL/Alarm 清理 + 5W1H
│   └── lib/
│       ├── youtube.ts    # 字幕获取 + 有效载荷校验 + 降级编排
│       ├── proxy.ts      # TCP CONNECT 隧道（缓冲/流式/直连）
│       ├── gemini.ts     # Gemini 流式 SSE / JSON 非流式 + 生成要求解析
│       ├── chapters.ts   # 章节切分与提取（含 extractChapterBody）
│       ├── types.ts      # 共享类型（Caption/Chapter/Requirements 等）
│       ├── log.ts        # 轻量日志（结构化输出到 stderr）
│       └── demo-captions.ts # 内置演示字幕兜底
├── wrangler.toml         # DO binding + assets + vars + migrations
└── .dev.vars.example     # 本地密钥模板
```

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GEMINI_API_KEY` | ✅ | Gemini API Key（`wrangler secret` 注入） |
| `GEMINI_MODEL` | 否 | 默认 `gemini-3.5-flash-lite` |
| `SESSION_TTL_SECONDS` | 否 | 会话 TTL，默认 86400（24h） |
| `YT_CLIENT` | 否 | 默认 `ANDROID`，可换 `WEB`/`IOS`/`TV` |
| `PROXY_HOST/PORT/USER/PASS` | 否 | Gemini 主出口代理隧道开关 |
| `PROXY_LIST` | 否 | 逗号分隔代理池 `host:port[:user[:pass]]`，YouTube 字幕多出口轮询 |

## 协议说明

- YouTube player/timedtext 为公开内部接口，仅供个人学习研究；请遵守目标平台服务条款
- 内置演示字幕仅为兜底，会明确标注「内置演示数据」
- Gemini 免费 Key 有速率限制，流式生成频繁触发时请稍候
