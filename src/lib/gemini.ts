/**
 * Gemini 调用封装：
 * - streamGenerate 流式（上游 SSE → 逐 chunk 回调），用于主文章生成
 * - generateJson 非流式（responseMimeType=application/json），用于 5W1H 与要求解析
 */
import type { Config } from '../config';
import type { ParsedRequirements } from './types';
import { httpsRequestViaProxy, httpsStreamViaProxy } from './proxy';

export interface GeminiStreamCallbacks {
  /** 每收到一段文本增量 */
  onDelta(text: string): void;
  /** 流结束 */
  onDone?(): void;
}

/** 流式生成：alt=sse 上游，回调返回文本增量 */
export async function streamGenerate(
  config: Config,
  prompt: string,
  callbacks: GeminiStreamCallbacks,
): Promise<void> {
  const host = 'generativelanguage.googleapis.com';
  const path = `/v1beta/models/${config.geminiModel}:streamGenerateContent`;
  const query = `alt=sse&key=${config.geminiApiKey}`;
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  });

  let chunks: AsyncIterable<Uint8Array>;
  let status: number;

  if (config.proxy) {
    // 本地/受限网络：走代理隧道（流式，逐块读取）
    const proxied = await httpsStreamViaProxy(
      config.proxy,
      'POST',
      host,
      `${path}?${query}`,
      { 'Content-Type': 'application/json' },
      payload,
    );
    status = proxied.status;
    chunks = proxied.chunks;
  } else {
    const resp = await fetch(`https://${host}${path}?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    status = resp.status;
    chunks = resp.ok
      ? { async *[Symbol.asyncIterator]() {
          const reader = resp.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } }
      : emptyChunks();
  }

  if (status !== 200) {
    throw new Error(`Gemini 流式请求失败 ${status}: ${(await collectString(chunks)).slice(0, 300)}`);
  }

  await consumeSse(chunks, callbacks);
  callbacks.onDone?.();
}

function emptyChunks(): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() {} };
}

/** 解析单条 SSE event 文本，把文本增量交给回调 */
function emitSseEvent(event: string, callbacks: GeminiStreamCallbacks): void {
  const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) return;
  try {
    const payload = JSON.parse(dataLine.slice(5).trim());
    const delta = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (delta) callbacks.onDelta(delta);
  } catch {
    /* 单帧损坏不中断整条流 */
  }
}

/** 逐事件消费 SSE：按 \n\n 拆帧，提取 candidates 文本增量 */
async function consumeSse(
  chunks: AsyncIterable<Uint8Array>,
  callbacks: GeminiStreamCallbacks,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const value of chunks) {
    buf += decoder.decode(value, { stream: true });
    let match: RegExpExecArray | null;
    // Gemini may frame SSE events with either LF or CRLF; accept both.
    while ((match = /\r?\n\r?\n/.exec(buf))) {
      const event = buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      emitSseEvent(event, callbacks);
    }
  }
  buf += decoder.decode();
  // Process a final event even when the stream has no trailing blank line.
  if (buf.trim()) emitSseEvent(buf, callbacks);
}

async function collectString(src: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of src) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

/** 非流式 JSON 输出：保证返回合法 JSON 对象。与流式路径一致，配置了代理时走代理隧道 */
export async function generateJson<T>(config: Config, prompt: string): Promise<T> {
  const host = 'generativelanguage.googleapis.com';
  const path = `/v1beta/models/${config.geminiModel}:generateContent`;
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  });

  let body: string;
  let status: number;
  if (config.proxy) {
    const res = await httpsRequestViaProxy(
      config.proxy,
      'POST',
      host,
      `${path}?key=${config.geminiApiKey}`,
      { 'Content-Type': 'application/json' },
      payload,
    );
    status = res.status;
    body = res.body;
  } else {
    const resp = await fetch(`https://${host}${path}?key=${config.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    status = resp.status;
    body = await resp.text().catch(() => '');
  }

  if (status !== 200) {
    throw new Error(`Gemini JSON 请求失败 ${status}: ${body.slice(0, 300)}`);
  }
  const data = JSON.parse(body) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text.trim()) throw new Error('Gemini 返回空结果');
  // 剥离可能的 markdown 代码围栏
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(clean) as T;
}

/** 生成要求：自然语言解析为结构化约束（JSON 模式） */
export async function parseRequirements(
  config: Config,
  naturalLanguage: string,
): Promise<ParsedRequirements> {
  const prompt = `你是需求解析器。把用户的自然语言生成要求解析为结构化约束，只输出 JSON，不要任何解释。
要求字段（可缺省）：taskType（任务类型）、outputStyle（输出风格）、audience（目标受众）、constraints（约束条件，若有多条用；分隔）。
用户输入："""${naturalLanguage}"""`;
  try {
    return await generateJson<ParsedRequirements>(config, prompt);
  } catch {
    // 解析失败时降级为整段原文作为 constraints
    return { constraints: naturalLanguage };
  }
}

/** 生成要求转 prompt 段落（有内容才附加） */
export function requirementsToPrompt(req?: ParsedRequirements): string {
  if (!req) return '';
  const parts: string[] = [];
  if (req.taskType) parts.push(`任务类型：${req.taskType}`);
  if (req.outputStyle) parts.push(`输出风格：${req.outputStyle}`);
  if (req.audience) parts.push(`目标受众：${req.audience}`);
  if (req.constraints) parts.push(`约束条件：${req.constraints}`);
  if (parts.length === 0) return '';
  return `\n\n## 用户生成要求\n${parts.map((p) => `- ${p}`).join('\n')}`;
}
