/** 运行时环境配置：读取并规范化环境变量 */

export interface AppEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  SESSION_TTL_SECONDS?: string;
  YT_CLIENT?: string;
  PROXY_HOST?: string;
  PROXY_PORT?: string;
  PROXY_USER?: string;
  PROXY_PASS?: string;
  SESSION_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export type ClientProfile = 'ANDROID' | 'WEB' | 'TV';

export interface Config {
  geminiApiKey: string;
  geminiModel: string;
  sessionTtlSeconds: number;
  ytClient: ClientProfile;
  proxy?: { host: string; port: number; user?: string; pass?: string };
}

export function readConfig(env: AppEnv): Config {
  const apiKey = env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 未配置，请通过 wrangler secret put GEMINI_API_KEY 设置');
  }
  const ttl = Number.parseInt(env.SESSION_TTL_SECONDS ?? '86400', 10);
  const host = env.PROXY_HOST?.trim();
  const port = Number.parseInt(env.PROXY_PORT ?? '80', 10);
  const client = normalizeClient(env.YT_CLIENT);

  return {
    geminiApiKey: apiKey,
    geminiModel: env.GEMINI_MODEL ?? 'gemini-2.0-flash',
    sessionTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 86400,
    ytClient: client,
    proxy:
      host && Number.isFinite(port) && port > 0
        ? { host, port, user: env.PROXY_USER?.trim() || undefined, pass: env.PROXY_PASS?.trim() || undefined }
        : undefined,
  };
}

function normalizeClient(v?: string): ClientProfile {
  const p = (v ?? 'ANDROID').toUpperCase();
  if (p === 'WEB' || p === 'TV') return p;
  return 'ANDROID';
}
