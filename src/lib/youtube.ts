/**
 * YouTube 字幕获取：
 * 1) 主路径：抓 watch 页提取动态 INNERTUBE_API_KEY + VISITOR_DATA（比硬编码 key 新，抗风控关键），
 *    再 POST youtubei/v1/player（多 client 重试），提取 captionTracks 后请求 timedtext
 * 2) 有效载荷校验：HTTP 状态 / body 非空 / JSON 可解析 / playabilityStatus / captions / captionTracks / timedtext 非空 / 段数>0
 * 3) 失败分类：fallbackReason，直连失败 → 代理池轮询（proxies × clients）→ 内置演示字幕
 *
 * 每条失败路径都会以结构化 JSON 输出到 stderr（wrangler dev 终端 / 线上 logs 可见），
 * 方便定位是 验证码(403) / 限流(429) / 无字幕轨 / JSON 解析失败 中的哪一种。
 */
import type { CaptionResult, CaptionSegment, FallbackReason } from './types';
import type { Config, ClientProfile, ProxyConfig } from '../config';
import { httpsRequestDirect, httpsRequestViaProxy } from './proxy';
import { logError, logWarn, logInfo } from './log';
import { DEMO_CAPTIONS } from './demo-captions';

const PLAYER_PATH = '/youtubei/v1/player';
const WATCH_HOST = 'www.youtube.com';
const WATCH_URL = 'https://www.youtube.com/watch?v=';
// 抓 watch 页新指纹用（baoyu skill 同一思路），UA 尽量新
const WATCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const DEFAULT_WEB_CLIENT_VERSION = '2.20260320.08.00';

/** client 上下文模板：ANDROID / WEB / IOS（指纹来自 baoyu-youtube-transcript，2026 仍存活），TV 保留但已废 */
const CLIENT_CONTEXTS: Record<ClientProfile, ClientProfileDef> = {
  ANDROID: {
    client: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      clientFormFactor: 'SMALL_FORM_FACTOR',
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14',
      platform: 'MOBILE',
      hl: 'en',
      gl: 'US',
    },
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US; Pixel 8 Pro; Build/AP1A.240405.002)',
  },
  WEB: {
    client: { clientName: 'WEB', hl: 'en', gl: 'US' }, // 无固定版本，用 watch 页动态 INNERTUBE_CLIENT_VERSION
    userAgent: WATCH_UA,
  },
  TV: {
    client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', hl: 'en', gl: 'US' },
    userAgent: WATCH_UA,
  },
  IOS: {
    client: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.0.22D5054f',
      platform: 'MOBILE',
      hl: 'en',
      gl: 'US',
    },
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X; en_US)',
  },
};

interface ClientProfileDef {
  client: Record<string, unknown>;
  userAgent: string;
}

/** watch 页提取的动态 API key + visitorData + 客户端版本 */
interface YtSession {
  apiKey: string;
  visitorData: string;
  webClientVersion: string;
  /** watch 页 Set-Cookie 会话（socket 直连时延续信任，解 bot 检测） */
  cookie?: string;
}

interface PlayerJson {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
}

/** 统一 HTTP 抽象：直连 socket / 代理隧道两者都实现同一签名 */
interface HttpFetchFn {
  (url: string, opts?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    body: string;
    headers?: Record<string, string>;
  }>;
}

/** 解析 YouTube 视频 URL，返回 videoId */
export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1) || null;
    const id = u.searchParams.get('v');
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * 字幕获取编排：直连（多 client）→ 代理池（proxies × clients）→ 演示字幕
 */
export async function fetchCaptions(videoId: string, config: Config): Promise<CaptionResult> {
  let lastReason: FallbackReason | undefined;

  // 1. 直连路径（海外/无墙环境）
  const direct = await fetchWithFetcher(videoId, directFetcher(), 'youtube');
  if (direct.ok) {
    logInfo('captions', '直连获取成功', { videoId, source: direct.result!.source });
    return direct.result!;
  }
  lastReason = direct.reason;
  logWarn('captions', '直连路径失败', { videoId, reason: direct.reason });

  // 2. 代理池轮询：每个代理独立抓 watch 页（拿到该出口的 visitorData），再试全部 client
  if (config.proxies.length > 0) {
    for (let i = 0; i < config.proxies.length; i++) {
      const proxy = config.proxies[i];
      const label = `${proxy.host}:${proxy.port}`;
      try {
        const proxied = await fetchWithFetcher(videoId, proxyFetcher(proxy), 'proxy');
        if (proxied.ok) {
          logInfo('captions', '代理池命中', { videoId, i, proxy: label, source: proxied.result!.source });
          return proxied.result!;
        }
        lastReason = proxied.reason;
        logWarn('captions', `代理 ${label} 失败`, { videoId, i, reason: proxied.reason });
      } catch (e) {
        lastReason = 'proxy_failed';
        logError('captions', `代理 ${label} 请求异常: ${e instanceof Error ? e.message : String(e)}`, { videoId, proxy: label });
      }
    }
  }

  // 3. 内置演示字幕兜底
  logWarn('captions', '全部失败，使用内置演示字幕', { videoId, lastReason: lastReason ?? 'no_captions_available' });
  return {
    videoId,
    title: DEMO_CAPTIONS.title,
    segments: DEMO_CAPTIONS.segments,
    source: 'demo',
    fallbackReason: lastReason ?? 'no_captions_available',
  };
}

/** 给定 fetcher：抓 session → 逐个 client 试 player → timedtext */
async function fetchWithFetcher(
  videoId: string,
  fetcher: HttpFetchFn,
  sourceLabel: 'youtube' | 'proxy',
): Promise<{ ok: boolean; result?: CaptionResult; reason?: FallbackReason }> {
  // 1. 抓 watch 页拿动态 key + visitorData；失败直接分类降级
  const sessionRes = await fetchYtSession(videoId, fetcher);
  if (!sessionRes.ok) return sessionRes;

  // 2. 多 client 重试（ANDROID → WEB → IOS，TV 已废放最后）
  const order: ClientProfile[] = ['ANDROID', 'WEB', 'IOS', 'TV'];
  let lastReason: FallbackReason | undefined;

  for (const profile of order) {
    const res = await tryClient(videoId, profile, sessionRes.session!, fetcher, sourceLabel);
    if (res.ok) return res;
    lastReason = res.reason;
    logWarn('captions', `${sourceLabel} client ${profile} 失败`, { videoId, profile, reason: res.reason });
  }
  return { ok: false, reason: lastReason ?? 'no_captions_available' };
}

/** 抓 watch 页 → 解析 INNERTUBE_API_KEY / VISITOR_DATA */
async function fetchYtSession(
  videoId: string,
  fetcher: HttpFetchFn,
): Promise<{ ok: boolean; session?: YtSession; reason?: FallbackReason }> {
  const watchUrl = `${WATCH_URL}${videoId}&hl=en&persist_hl=1&has_verified=1&bpctr=9999999999`;
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': WATCH_UA,
  };

  let res = await fetcher(watchUrl, { headers });
  let html = res.body;
  if (res.status === 429) return { ok: false, reason: 'youtube_rate_limited' };
  if (res.status === 403) return { ok: false, reason: 'youtube_captcha' };
  if (res.status !== 200 || !html.trim()) return { ok: false, reason: 'youtube_empty_body' };

  // 提取 watch 页 Set-Cookie 会话（socket 直连时用于后续请求延续信任）
  const watchCookie = extractCookies(res.headers?.['set-cookie']);

  // consent 页处理（baoyu 同款）
  if (html.includes('action="https://consent.youtube.com/s"')) {
    const v = html.match(/name="v" value="(.*?)"/);
    if (v) {
      const ok = await fetcher(watchUrl, { headers: { ...headers, Cookie: `CONSENT=YES+${v[1]}` } });
      if (ok.status === 200 && ok.body.trim()) html = ok.body;
    }
  }

  const apiKey = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1];
  if (!apiKey) {
    if (html.includes('class="g-recaptcha"')) {
      logWarn('yt-session', 'watch 页有 reCAPTCHA（IP 被风控）', { videoId });
      return { ok: false, reason: 'youtube_captcha' };
    }
    logWarn('yt-session', 'watch 页未提取到 INNERTUBE_API_KEY', { videoId, len: html.length, snippet: html.replace(/\s+/g, ' ').slice(0, 200) });
    return { ok: false, reason: 'youtube_invalid_json' };
  }
  const visitorData =
    html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] ||
    html.match(/"visitorData":"([^"]+)"/)?.[1] ||
    '';
  const webClientVersion =
    html.match(/"INNERTUBE_CLIENT_VERSION":\s*"([^"]+)"/)?.[1] ||
    html.match(/"clientVersion":"([^"]+)"/)?.[1] ||
    DEFAULT_WEB_CLIENT_VERSION;
  logInfo('yt-session', 'watch 页 session 提取成功', { videoId, hasVisitor: !!visitorData, webClientVersion, hasCookie: !!watchCookie });
  return { ok: true, session: { apiKey, visitorData, webClientVersion, cookie: watchCookie || undefined } };
}

/** 从 Set-Cookie 响应头提取 Cookie: 值（仅保留 SID/__Secure- 等会话相关，逗号分隔） */
function extractCookies(setCookie?: string): string {
  if (!setCookie) return '';
  // 可能包含多个 Set-Cookie 头（HTTP/1.1 多块）；取每个的 name=value（到第一个 ;）
  const parts = setCookie.split(/, /).filter(Boolean).map((c) => c.split(';')[0]?.trim());
  if (parts.length === 0) return '';
  const allowlist = ['SID', 'SIDCC', '__Secure-3PSID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO', 'PREF', 'VISITOR_INFO1_LIVE', 'YSC', 'SOCS', '__Secure-YEC'];
  const picked = parts.filter((p) => allowlist.some((k) => p.startsWith(k)));
  return picked.length ? picked.join('; ') : '';
}

/** 单个 client：POST player（带 visitorData + 完整浏览器头）→ 提取字幕轨 → GET timedtext */
async function tryClient(
  videoId: string,
  profile: ClientProfile,
  session: YtSession,
  fetcher: HttpFetchFn,
  sourceLabel: 'youtube' | 'proxy',
): Promise<{ ok: boolean; result?: CaptionResult; reason?: FallbackReason }> {
  const def = CLIENT_CONTEXTS[profile];
  // WEB 用 watch 页动态版本；ANDROID/IOS/TV 用指纹自带的版本
  const clientVersion: string =
    typeof def.client.clientVersion === 'string' ? def.client.clientVersion : session.webClientVersion;
  const client = { ...def.client, clientVersion, visitorData: session.visitorData };

  const url = `https://${WATCH_HOST}${PLAYER_PATH}?key=${session.apiKey}`;
  const playerHeaders: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    Origin: `https://${WATCH_HOST}`,
    Referer: `${WATCH_URL}${videoId}`,
    'User-Agent': def.userAgent,
    'X-YouTube-Client-Name': PROFILE_CLIENT_HEADER[profile],
    'X-YouTube-Client-Version': clientVersion,
  };
  if (session.visitorData) playerHeaders['X-Goog-Visitor-Id'] = session.visitorData;
  if (session.cookie) playerHeaders['Cookie'] = session.cookie;

  const playerRes = await fetcher(url, {
    method: 'POST',
    headers: playerHeaders,
    body: JSON.stringify({
      context: { client, request: { useSsl: true } },
      videoId,
    }),
  });
  const validated = validatePlayer(playerRes.status, playerRes.body);
  if (!validated.ok) {
    // 专项提取 playability 详情，定位是真无权限还是风控
    let playInfo = '';
    try {
      const j = JSON.parse(playerRes.body) as PlayerJson;
      const ps = j.playabilityStatus;
      playInfo = ps ? `${ps.status} :: ${ps.reason ?? ''}`.slice(0, 200) : 'no playabilityStatus';
    } catch { /* 已是 JSON，兜底 */ }
    logWarn('player', `${sourceLabel} ${profile} HTTP ${playerRes.status} 校验失败`, {
      videoId,
      reason: validated.reason,
      status: playerRes.status,
      playInfo,
      bodySnippet: playerRes.body.replace(/\s+/g, ' ').slice(0, 300) || '<空 body>',
    });
    return { ok: false, reason: validated.reason };
  }

  const json = validated.json!;
  const tracks = json.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) {
    logWarn('timedtext', `${sourceLabel} ${profile} player 响应中无字幕轨`, { videoId, playabilityStatus: json.playabilityStatus?.status, bodySnippet: playerRes.body.replace(/\s+/g, ' ').slice(0, 200) });
    return { ok: false, reason: 'youtube_no_caption_tracks' };
  }

  const track =
    tracks.find((t) => t.languageCode === 'en' && t.baseUrl?.includes('kind=asr')) ??
    tracks.find((t) => t.languageCode?.startsWith('en')) ??
    tracks.find((t) => t.languageCode?.startsWith('zh')) ??
    tracks[0];
  logInfo('timedtext', `${sourceLabel} ${profile} 选定字幕轨`, { videoId, lang: track.languageCode, asr: track.baseUrl?.includes('kind=asr') });
  if (!track.baseUrl) {
    logWarn('timedtext', `${sourceLabel} ${profile} 字幕轨无 baseUrl`, { videoId, lang: track.languageCode });
    return { ok: false, reason: 'timedtext_empty_body' };
  }

  const ttUrl = new URL(track.baseUrl);
  ttUrl.searchParams.set('fmt', 'json3');
  const ttHeaders: Record<string, string> = { 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': def.userAgent };
  if (session.cookie) ttHeaders['Cookie'] = session.cookie;
  const ttRes = await fetcher(ttUrl.toString(), { headers: ttHeaders });
  if (ttRes.status !== 200 || !ttRes.body.trim()) {
    logWarn('timedtext', `${sourceLabel} ${profile} timedtext 返回空/失败`, { videoId, lang: track.languageCode, status: ttRes.status });
    return { ok: false, reason: 'timedtext_empty_body' };
  }

  const segments = parseTimedText(ttRes.body);
  if (segments.length === 0) {
    logWarn('timedtext', `${sourceLabel} ${profile} timedtext 解析后无有效段`, { videoId, lang: track.languageCode, bodyLen: ttRes.body.length });
    return { ok: false, reason: 'timedtext_empty_body' };
  }

  logInfo('timedtext', `${sourceLabel} ${profile} timedtext 解析成功`, { videoId, lang: track.languageCode, segments: segments.length });
  return {
    ok: true,
    result: {
      videoId,
      title: json.videoDetails?.title ?? 'YouTube 视频',
      segments,
      source: sourceLabel,
    },
  };
}

const PROFILE_CLIENT_HEADER: Record<ClientProfile, string> = {
  ANDROID: '3',
  WEB: '1',
  TV: '7',
  IOS: '5',
};

/** 有效载荷校验核心：状态/空body/JSON/playability 全部通过才算 ok */
function validatePlayer(
  status: number,
  text: string,
): { ok: boolean; json?: PlayerJson; reason?: FallbackReason } {
  if (status === 429) return { ok: false, reason: 'youtube_rate_limited' };
  if (status === 403) return { ok: false, reason: 'youtube_captcha' };
  if (!text.trim()) return { ok: false, reason: 'youtube_empty_body' };

  let json: PlayerJson;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'youtube_invalid_json' };
  }

  const ps = json.playabilityStatus?.status;
  if (ps && ps !== 'OK' && ps !== 'LIVE_STREAM') {
    return { ok: false, reason: 'youtube_playability_error' };
  }
  return { ok: true, json };
}

/** 直连 fetcher：socket 直连 startTls + 手动 HTTP/1.1（绕过 fetch 的 429/HTTP2 风控指纹）
 * 带超时保护：直连若挂死（如无墙外网络）则快速降级到代理池，而不是无限等待。 */
function directFetcher(): HttpFetchFn {
  return async (url, opts) => {
    try {
      const u = new URL(url);
      const host = u.hostname;
      const path = `${u.pathname}${u.search}`;
      const p = httpsRequestDirect(opts?.method === 'POST' ? 'POST' : 'GET', host, path, opts?.headers, opts?.body);
      const race = await Promise.race([
        p,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), DIRECT_TIMEOUT_MS)),
      ]);
      if (race === 'timeout') {
        logWarn('http', '直连超时，降级到代理池', { url, timeoutMs: DIRECT_TIMEOUT_MS });
        return { status: 0, body: '' };
      }
      return race;
    } catch (e) {
      logError('http', `直连请求异常: ${e instanceof Error ? e.message : String(e)}`, { url });
      return { status: 0, body: '' };
    }
  };
}

const DIRECT_TIMEOUT_MS = 10_000;

/** 代理 fetcher：CONNECT 隧道 + 手动 HTTP（host 取自 URL，path 取自 URL path+search）
 * 带超时保护：坏代理（不响应 CONNECT / TLS 卡死）快速跳过，不拖慢整个代理池轮询。 */
function proxyFetcher(proxy: ProxyConfig): HttpFetchFn {
  return async (url, opts) => {
    const u = new URL(url);
    const host = u.hostname;
    const path = `${u.pathname}${u.search}`;
    const p = httpsRequestViaProxy(proxy, opts?.method === 'POST' ? 'POST' : 'GET', host, path, opts?.headers, opts?.body);
    const race = await Promise.race([
      p,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), PROXY_TIMEOUT_MS)),
    ]);
    if (race === 'timeout') {
      logWarn('http', '代理请求超时，跳过', { url, proxy: `${proxy.host}:${proxy.port}`, timeoutMs: PROXY_TIMEOUT_MS });
      return { status: 0, body: '' };
    }
    return race;
  };
}

const PROXY_TIMEOUT_MS = 15_000;

/** 解析 timedtext JSON3 → 时间戳+文本数组
 * 兼容两种 json3 结构：新版 event.segs[]（tStartMs 时间）+ 旧版 event.a[].segs[]（t 时间）。
 * 与 test/fetch_youtube_transcript.mjs 的 parseTranscriptJson3 保持同等能力（html 反转义 + 换行清洗）。 */
export function parseTimedText(raw: string): CaptionSegment[] {
  try {
    const data = JSON.parse(raw);
    const events: Record<string, unknown>[] = Array.isArray(data?.events) ? data.events : [];
    const out: CaptionSegment[] = [];

    // 提取任意层级的字幕段 + 统一 utf8 文本拼接（事件可能嵌套 a[]）
    const segsOf = (ev: Record<string, unknown>): { utf8?: string }[] => {
      const direct = Array.isArray(ev.segs) ? (ev.segs as { utf8?: string }[]) : [];
      if (direct.length) return direct;
      const a = Array.isArray(ev.a) ? (ev.a as { segs?: { utf8?: string }[] }[]) : [];
      return a.flatMap((x) => (Array.isArray(x?.segs) ? x.segs : []));
    };

    for (const ev of events) {
      const segs = segsOf(ev);
      const text = segs.map((s) => htmlUnescape(String(s?.utf8 ?? '').replace(/\n+/g, ' ').trim())).filter(Boolean).join(' ').replace(/ {2,}/g, ' ').trim();
      if (!text) continue;
      const ms = Number((ev as { tStartMs?: unknown }).tStartMs ?? (ev as { t?: unknown }).t ?? 0);
      if (!Number.isFinite(ms) || ms < 0) continue;
      out.push({ time: formatTime(ms), text });
    }
    return out;
  } catch {
    return [];
  }
}

/** HTML 实体反转义（&amp; &lt; &gt; &quot; &#39; 等），json3 字幕段常用 */
function htmlUnescape(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 16)));
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}