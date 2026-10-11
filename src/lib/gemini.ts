/**
 * Gemini 调用封装：
 * - streamGenerate 流式（上游 SSE → 逐 chunk 回调），用于主文章生成
 * - generateJson 非流式（responseMimeType=application/json），用于 5W1H 与要求解析
 */
import type { Config } from '../config';
import type { ParsedRequirements } from './types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
  const url = `${BASE}/${config.geminiModel}:streamGenerateContent?alt=sse&key=${config.geminiApiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Gemini 流式请求失败 ${resp.status}: ${err.slice(0, 300)}`);
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 上游 SSE：data: {...}\n\n，可一次含多条
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine.slice(5).trim());
      const delta = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (delta) callbacks.onDelta(delta);
    }
  }
  // 处理剩余（无结尾双换行）
  if (buf.trim()) {
    const dataLine = buf.split('\n').find((l) => l.startsWith('data:'));
    if (dataLine) {
      try {
        const payload = JSON.parse(dataLine.slice(5).trim());
        const delta = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (delta) callbacks.onDelta(delta);
      } catch {
        /* ignore */
      }
    }
  }
  callbacks.onDone?.();
}

/** 非流式 JSON 输出：保证返回合法 JSON 对象 */
export async function generateJson<T>(config: Config, prompt: string): Promise<T> {
  const url = `${BASE}/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Gemini JSON 请求失败 ${resp.status}: ${err.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
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
