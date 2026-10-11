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

### 可选：webshare.io 代理（应对 YouTube 验证码/限流）

Cloudflare Worker 的 `fetch` 不支持代理，本项目用 **TCP Socket** 实现 HTTP CONNECT 隧道：

```bash
npx wrangler secret put PROXY_HOST   # proxy.webshare.io
npx wrangler secret put PROXY_PORT   # 80 或 8080
npx wrangler secret put PROXY_USER   # 代理账号
npx wrangler secret put PROXY_PASS   # 代理密码
```

不配置时该模块零开销、不激活。

## 架构

```
浏览器单页 ──POST /api/article──▶ Worker（SSE 流式）
  │                                  ├─▶ YouTube player API → timedtext 字幕
  │                                  │     └─ 多 client 重试 / TCP 代理 / 演示字幕降级
  │                                  ├─▶ Gemini streamGenerateContent?alt=sse
  │                                  └─▶ SessionDO.save（TTL + Alarm 清理）
  │
  └──POST /api/sessions/:id/chapters/:n/5w1h──▶ SessionDO
       （请求不携带文章全文，服务端读取会话上下文 → Gemini JSON 模式 → 结构化 5W1H）
```

## 实现细节

### 1. YouTube 字幕获取（`src/lib/youtube.ts`）

不解析 watch 页面 HTML（易碎），直接调 YouTube 内部 JSON API：

1. `POST https://www.youtube.com/youtubei/v1/player`，body 携带 ANDROID client 上下文 + 公开 key
2. 从响应 `captions.playerCaptionsTracklistRenderer.captionTracks[]` 选最佳字幕轨（优先英文 ASR）
3. `GET timedtext?fmt=json3` 得到 JSON，解析为 `[{time, text}]`

**有效载荷校验链路**（不只看 `response.ok`，覆盖 PoToken 等场景）：

```
HTTP 状态 → body 非空 → JSON 可解析 → playabilityStatus → captions 存在
→ captionTracks 非空 → timedtext body 非空 → 字幕段数 > 0
```

**降级顺序**：ANDROID → WEB → TV client → TCP 代理 → 内置演示字幕。
每步失败记录 `fallbackReason`（`youtube_empty_body` / `youtube_no_caption_tracks` / `timedtext_empty_body` / `youtube_captcha` / `youtube_rate_limited` 等），前端琥珀色徽章明示。

### 2. TCP 代理隧道（`src/lib/proxy.ts`）

`fetch` 不支持代理，改用 `connect()`（`cloudflare:sockets`）：

```
TCP connect(代理) → CONNECT youtube.com:443 → 读 200 → startTls()（特性检测回退）
→ 手动 HTTP/1.1 请求 → 解析响应头与 body
```

### 3. Gemini 流式输出（`src/lib/gemini.ts`）

- 上游：`streamGenerateContent?alt=sse`（Gemini 原生 SSE）
- Worker 边读边转写为自定义 SSE：`data: {"type":"delta","text":"..."}`，15s 定时 `: keep-alive` 防假死
- 前端 `fetch` + `ReadableStream` + `TextDecoder` 逐块消费增量渲染
- 章节切分：流式检测 `## ` 标题行，实时推送 `chapter` 事件驱动前端挂载 `[5W1H]` 按钮

### 4. 生成要求注入

- 自然语言先经 Gemini 解析为结构化约束（任务类型 / 输出风格 / 目标受众 / 约束条件）
- 合并进主文章 prompt，保证"体现约束、不超范围"

### 5. 章节 5W1H（`src/sessions.ts`）

**关键约束：请求不得携带整篇文章**。

- `SessionDO`（Durable Object）保存本次生成上下文 `{videoId, title, captions, requirements, article, chapters, createdAt, expiresAt}`（写入 DO Storage，非内存）
- 前端点 `[5W1H]` 只发 `POST /api/sessions/:id/chapters/:n/5w1h`（仅 sessionId + 章节号）
- DO 从存储读取整篇文章与当前章节，构造「整篇上下文 + 当前章节」prompt，调 Gemini 非流式 JSON 模式，返回固定 `{who, what, when, where, why, how}`
- **TTL 生命周期**：生成时写 `expiresAt = now + SESSION_TTL_SECONDS`（默认 24h），DO Alarm 到期幂等删除；读取时校验 `expiresAt`，即使 Alarm 延迟也不放行，返回 `410 Gone`

为什么用 DO 而非 KV：KV 单值 1MB 上限 + 最终一致；DO 单点强一致、适合存大上下文。

## 工程取舍与亮点

| 取舍 | 说明 |
| --- | --- |
| 字幕主路径用 JSON API 而非解析 HTML | 稳定性与简洁度双赢 |
| 有效载荷校验显式建模失败模式 | `200 + 空 body` 不再被误判为成功，降级可观测 |
| 代理模块独立可选 | 无 `PROXY_*` 配置时零开销；`startTls` 特性检测保证兼容 |
| 长流式放普通 Worker、上下文放 DO | 规避 DO CPU 事件限制，兼顾实时性与一致性 |
| SessionDO 带 TTL + Alarm 幂等清理 | 资源可回收，过期语义明确（410） |
| 前端零框架 + 手写轻量 Markdown 渲染 | 避免构建链膨胀，产物 < 13KB |

## 难度评估

**中上（约 4/5）**：

- 字幕获取链路 + TCP 代理隧道：最不确定，约占 40% 工作量；`startTls` / 反爬形态只能在真实部署环境验证
- 流式 SSE + DO 会话：方案成熟，中等难度
- 前端 + prompt 编排：中等偏下
- 对熟悉 Cloudflare Workers 的工程师约 2~3 天；主要风险点是 YouTube 反爬策略变化

## 目录结构

```
youtube-article-ai/
├── public/               # 前端单页（index.html / app.js / style.css）
├── scripts/build.mjs     # esbuild 打包 Worker + 前端
├── src/
│   ├── index.ts          # Worker 入口：路由 + SSE 组装
│   ├── config.ts         # 环境变量规范化
│   ├── sessions.ts       # SessionDO：TTL/Alarm 清理 + 5W1H
│   └── lib/
│       ├── youtube.ts    # 字幕获取 + 有效载荷校验 + 降级编排
│       ├── proxy.ts      # TCP CONNECT 隧道 + startTls
│       ├── gemini.ts     # 流式 SSE 转写 / JSON 非流式
│       ├── requirements.ts # 生成要求解析（并入 gemini.ts）
│       ├── chapters.ts   # 章节切分与提取
│       └── demo-captions.ts # 内置演示字幕兜底
├── wrangler.toml         # DO binding + assets + vars
└── .dev.vars.example     # 本地密钥模板
```

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GEMINI_API_KEY` | ✅ | Gemini API Key（`wrangler secret` 注入） |
| `GEMINI_MODEL` | 否 | 默认 `gemini-2.0-flash` |
| `SESSION_TTL_SECONDS` | 否 | 会话 TTL，默认 86400（24h） |
| `YT_CLIENT` | 否 | 默认 `ANDROID`，可换 `WEB`/`TV` |
| `PROXY_HOST/PORT/USER/PASS` | 否 | webshare 代理隧道开关 |

## 协议说明

- YouTube player/timedtext 为公开内部接口，仅供个人学习研究；请遵守目标平台服务条款
- 内置演示字幕仅为兜底，会明确标注「内置演示数据」
- Gemini 免费 Key 有速率限制，流式生成频繁触发时请稍候
