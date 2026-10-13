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
  /** 逗号分隔的多个代理：host:port:user:pass,host2:port2:...（YouTube 字幕轮询出口用） */
  PROXY_LIST?: string;
  SESSION_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export type ClientProfile = 'ANDROID' | 'WEB' | 'TV' | 'IOS';

export interface ProxyConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

export interface Config {
  geminiApiKey: string;
  geminiModel: string;
  sessionTtlSeconds: number;
  ytClient: ClientProfile;
  /** 主代理：Gemini 流式/JSON 请求用（保持单出口） */
  proxy?: ProxyConfig;
  /** 字幕出口代理池：YouTube 字幕获取按此列表逐个尝试 */
  proxies: ProxyConfig[];
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
  const proxies = parseProxyList(env.PROXY_LIST);

  return {
    geminiApiKey: apiKey,
    geminiModel: env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    sessionTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 86400,
    ytClient: client,
    proxy:
      host && Number.isFinite(port) && port > 0
        ? { host, port, user: env.PROXY_USER?.trim() || undefined, pass: env.PROXY_PASS?.trim() || undefined }
        : undefined,
    proxies,
  };
}

/** 解析逗号分隔的代理列表：host:port[:user[:pass]],host2:port2:... */
function parseProxyList(v?: string): ProxyConfig[] {
  if (!v) return [];
  const out: ProxyConfig[] = [];
  for (const raw of v.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const parts = item.split(':');
    const host = parts[0]?.trim();
    const port = Number.parseInt(parts[1] ?? '', 10);
    if (!host || !Number.isFinite(port) || port <= 0) continue;
    out.push({
      host,
      port,
      user: parts[2]?.trim() || undefined,
      pass: parts[3]?.trim() || undefined,
    });
  }
  return out;
}

function normalizeClient(v?: string): ClientProfile {
  const p = (v ?? 'ANDROID').toUpperCase();
  if (p === 'WEB' || p === 'TV' || p === 'IOS') return p;
  return 'ANDROID';
}
