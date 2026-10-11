/**
 * Worker 入口：
 * - GET 静态资源（assets 绑定）
 * - POST /api/article        生成主文章（SSE 流式）
 * - POST /api/sessions/:id/chapters/:n/5w1h   章节 5W1H（不携带文章全文）
 */
import { readConfig, type AppEnv } from './config';
import { fetchCaptions, extractVideoId } from './lib/youtube';
import { streamGenerate, parseRequirements, requirementsToPrompt } from './lib/gemini';
import { createChapterScanner, extractChapters } from './lib/chapters';
import type { SessionContext } from './sessions';
import type { CaptionResult, ParsedRequirements } from './lib/types';

export { SessionDO } from './sessions';

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      // 静态资源（前端单页）
      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }
      if (request.method === 'POST' && url.pathname === '/api/article') {
        return handleArticle(request, env);
      }
      const m5 = /^\/api\/sessions\/([^/]+)\/chapters\/(\d+)\/5w1h$/.exec(url.pathname);
      if (request.method === 'POST' && m5) {
        return handleFiveW1H(env, m5[1], Number.parseInt(m5[2], 10));
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return jsonError(e);
    }
  },
};

/** 主文章生成：字幕 → 要求解析 → Gemini 流式 → SSE 转发 + 章节切分 + 会话保存 */
async function handleArticle(request: Request, env: AppEnv): Promise<Response> {
  const config = readConfig(env);
  const body = (await request.json()) as { url?: string; requirement?: string };
  const videoId = extractVideoId(body.url ?? '');
  if (!videoId) return jsonError(new Error('无法识别 YouTube 链接，请检查链接格式'), 400);

  // 1. 获取字幕（多级降级）
  const captions: CaptionResult = await fetchCaptions(videoId, config);

  // 2. 生成要求解析（可选）
  let requirements: ParsedRequirements | undefined;
  if (body.requirement?.trim()) {
    requirements = await parseRequirements(config, body.requirement.trim());
  }

  // 3. 构造 prompt
  const prompt = buildArticlePrompt(captions, requirements);

  // 4. 流式生成，SSE 转发
  const scanner = createChapterScanner();
  let article = '';
  const encoder = new TextEncoder();
  let sessionId: string | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      // keep-alive：上游卡顿时维持连接
      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, 15000);

      try {
        await streamGenerate(config, prompt, {
          onDelta(text) {
            article += text;
            const chapters = scanner.feed(text);
            for (const ch of chapters) send({ type: 'chapter', index: ch.index, title: ch.title });
            send({ type: 'delta', text });
          },
        });

        // 章节兜底扫描（流式可能跨边界漏检）
        const finalChapters = scanner.list().length
          ? scanner.list()
          : extractChapters(article);

        // 5. 保存会话上下文（DO），供 5W1H 使用
        sessionId = await saveSession(env, {
          videoId,
          title: captions.title,
          captions: captions.segments,
          requirements,
          article,
          chapters: finalChapters,
          createdAt: Date.now(),
          expiresAt: Date.now() + config.sessionTtlSeconds * 1000,
        });
        send({
          type: 'meta',
          sessionId,
          title: captions.title,
          source: captions.source,
          fallbackReason: captions.fallbackReason ?? null,
          chapters: finalChapters,
        });
      } catch (e) {
        send({ type: 'error', message: errMsg(e) });
      } finally {
        clearInterval(keepAlive);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** 章节 5W1H：转发到 SessionDO，请求不携带文章全文 */
async function handleFiveW1H(env: AppEnv, sessionId: string, index: number): Promise<Response> {
  let id: DurableObjectId;
  try {
    id = env.SESSION_DO.idFromString(sessionId);
  } catch {
    return new Response('会话 ID 无效', { status: 400 });
  }
  const stub = env.SESSION_DO.get(id);
  const res = await stub.fetch(
    new Request(`https://do.local/chapters/${index}/5w1h`, { method: 'POST' }),
  );
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } });
}

/** 保存会话到 DO，返回 sessionId */
async function saveSession(env: AppEnv, context: Omit<SessionContext, 'expiresAt'> & { expiresAt: number }) {
  const id = env.SESSION_DO.newUniqueId();
  const stub = env.SESSION_DO.get(id);
  const { article, captions, videoId, ...rest } = context;
  const res = await stub.fetch(
    new Request('https://do.local/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ article, captions, videoId, ...rest }),
    }),
  );
  if (!res.ok) throw new Error('会话保存失败');
  return id.toString();
}

/** 主文章 prompt：字幕 + 生成要求 + 输出规范（带章节） */
function buildArticlePrompt(captions: CaptionResult, requirements?: ParsedRequirements): string {
  const captionsText = captions.segments.map((c) => `[${c.time}] ${c.text}`).join('\n');
  return `你是资深中文视频解读编辑。基于用户提供的 YouTube 字幕，生成一篇结构清晰的中文对话解读文章。
要求：
- 使用 Markdown；一级标题用 # 写文章主标题；二级标题用 ## 组织 3~5 个章节
- 每个章节围绕视频中的具体观点展开，适当引用字幕中的原话，保持客观
- 全文用中文，语言正式简练，不用感叹号堆砌
${requirementsToPrompt(requirements)}
- 输出仅包含 Markdown 正文，不要任何额外说明

【视频标题】${captions.title}
【视频字幕】
"""${captionsText}"""`;
}

function jsonError(e: unknown, status = 500): Response {
  return new Response(JSON.stringify({ error: errMsg(e) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return JSON.stringify(e) ?? '未知错误';
}
