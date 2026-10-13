/**
 * SessionDO：保存本次生成上下文（字幕全文 + 生成要求 + 主文章 + 章节索引）。
 * - TTL：写入时设置 expiresAt，并安排 alarm 幂等清理
 * - 读取前校验 expiresAt：即使 alarm 延迟也不放行过期会话（返回 410）
 * - 5W1H：基于保存的整篇上下文 + 当前章节构造 prompt，非流式 JSON 返回
 */
import type { CaptionSegment, Chapter, ParsedRequirements } from './lib/types';
import { extractChapterBody } from './lib/chapters';
import { readConfig, type AppEnv } from './config';
import { generateJson } from './lib/gemini';

export interface SessionContext {
  videoId: string;
  title: string;
  captions: CaptionSegment[];
  requirements?: ParsedRequirements;
  article: string;
  chapters: Chapter[];
  createdAt: number;
  expiresAt: number;
}

interface FiveW1H {
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
}

const KEY = 'ctx';

/** Durable Object：每个 session 一个实例 */
export class SessionDO {
  private ctx: DurableObjectState;
  private env: AppEnv;
  private ttlSeconds: number;

  constructor(state: DurableObjectState, env: AppEnv) {
    this.ctx = state;
    this.env = env;
    this.ttlSeconds = parseInt(env.SESSION_TTL_SECONDS ?? '86400', 10) || 86400;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/save') {
      return this.save(request);
    }
    if (request.method === 'POST' && path.endsWith('/5w1h')) {
      return this.fiveW1H(request, path);
    }
    if (request.method === 'GET' && path === '/health') {
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  /** 保存生成上下文（主文章流式完成后调用） */
  private async save(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      videoId?: string;
      title?: string;
      captions?: CaptionSegment[];
      requirements?: ParsedRequirements;
      article?: string;
      chapters?: Chapter[];
    };
    if (!body.article || !body.captions?.length || !body.videoId) {
      return new Response('缺少必要字段', { status: 400 });
    }
    const now = Date.now();
    const context: SessionContext = {
      videoId: body.videoId,
      title: body.title ?? '',
      captions: body.captions,
      requirements: body.requirements,
      article: body.article,
      chapters: body.chapters ?? [],
      createdAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
    };
    await this.ctx.storage.put(KEY, context);
    // 幂等：重新安排 alarm，避免旧 alarm 提前清掉新会话
    await this.ctx.storage.setAlarm(context.expiresAt);
    return Response.json({ ok: true, expiresAt: context.expiresAt });
  }

  /** 5W1H：请求体仅含章节序号，不携带文章全文 */
  private async fiveW1H(_request: Request, path: string): Promise<Response> {
    const context = await this.readOr410();
    if (context instanceof Response) return context;

    const m = /\/chapters\/(\d+)\/5w1h$/.exec(path);
    const index = m ? Number.parseInt(m[1], 10) : NaN;
    if (!Number.isInteger(index) || index < 0) {
      return new Response('章节序号无效', { status: 400 });
    }
    const chapter = context.chapters.find((c) => c.index === index);
    if (!chapter) return new Response('章节不存在', { status: 404 });

    const chapterBody = extractChapterBody(context.article, index);
    const prompt = buildFiveW1HPrompt(context, chapter.title, chapterBody);

    // 与主文章生成保持一致：配置了代理时走代理隧道，避免受限网络直连 Google 卡死
    try {
      const data = await generateJson<FiveW1H>(readConfig(this.env), prompt);
      return Response.json({ chapter: chapter.title, ...data });
    } catch (e) {
      return new Response(`5W1H 生成失败: ${errMsg(e)}`, { status: 500 });
    }
  }

  /** 读取上下文；过期返回 410（即使 alarm 尚未清理） */
  private async readOr410(): Promise<SessionContext | Response> {
    const context = (await this.ctx.storage.get<SessionContext>(KEY)) ?? null;
    if (!context) return new Response('会话不存在', { status: 404 });
    if (Date.now() > context.expiresAt) {
      await this.deleteSession();
      return new Response('会话已过期', { status: 410 });
    }
    return context;
  }

  /** alarm：到期后幂等清理会话 */
  async alarm(): Promise<void> {
    const context = (await this.ctx.storage.get<SessionContext>(KEY)) ?? null;
    if (!context) return;
    if (Date.now() >= context.expiresAt) {
      await this.deleteSession();
    }
  }

  private async deleteSession(): Promise<void> {
    await this.ctx.storage.delete(KEY);
    await this.ctx.storage.deleteAlarm();
  }
}

/** 构造 5W1H prompt：整篇视频上下文 + 当前章节 */
function buildFiveW1HPrompt(context: SessionContext, chapterTitle: string, chapterBody: string): string {
  const captionsText = context.captions
    .map((c) => `[${c.time}] ${c.text}`)
    .join('\n')
    .slice(0, 12000);
  const reqText = context.requirements
    ? JSON.stringify(context.requirements, null, 2)
    : '（无）';

  return `你是视频内容分析师。基于以下【整篇视频字幕】与【当前章节】，对该章节做 5W1H 总结。
要求：
- 严格只输出 JSON，键为 who / what / when / where / why / how，值为中文短句
- 结合整篇视频内容与当前章节上下文，不要脱离视频内容编造
- when/where 若视频未提及，写"未明确提及"

【整篇视频字幕】
"""${captionsText}"""

【生成要求】
${reqText}

【当前章节标题】
${chapterTitle}

【当前章节正文】
"""${chapterBody}"""`;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return JSON.stringify(e) ?? '未知错误';
}
