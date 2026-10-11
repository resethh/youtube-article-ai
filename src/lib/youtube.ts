/**
 * YouTube 字幕获取：
 * 1) 主路径：POST youtubei/v1/player（多 client 重试），提取 captionTracks，再请求 timedtext
 * 2) 有效载荷校验：HTTP 状态 / body 非空 / JSON 可解析 / playabilityStatus / captions / captionTracks / timedtext 非空 / 段数>0
 * 3) 失败分类：fallbackReason，逐级降级到 TCP 代理 → 内置演示字幕
 */
import type { CaptionResult, CaptionSegment, FallbackReason } from './types';
import type { Config, ClientProfile } from '../config';
import { httpsRequestViaProxy } from './proxy';
import { DEMO_CAPTIONS } from './demo-captions';

const PLAYER_PATH = '/youtubei/v1/player';
const TIMEDTEXT_HOST = 'www.youtube.com';

/** client 上下文模板，覆盖 ANDROID / WEB / TV 三种 profile */
const CLIENT_CONTEXTS: Record<ClientProfile, { client: Record<string, unknown>; apiKey: string }> = {
  ANDROID: {
    client: {
      clientName: 'ANDROID',
      clientVersion: '20.7.41',
      androidSdkVersion: 30,
      hl: 'en',
      gl: 'US',
    },
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_SzB1VpwO6',
  },
  WEB: {
    client: { clientName: 'WEB', clientVersion: '2.20250203.10.00', hl: 'en', gl: 'US' },
    apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilwY9nK3b5B3-8',
  },
  TV: {
    client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', hl: 'en', gl: 'US' },
    apiKey: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilwY9nK3b5B3-8',
  },
};

interface PlayerJson {
  playabilityStatus?: { status?: string };
  videoDetails?: { title?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
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
 * 字幕获取编排：主路径（多 client）→ 代理 → 演示字幕
 */
export async function fetchCaptions(videoId: string, config: Config): Promise<CaptionResult> {
  const attempts: ClientProfile[] = [
    config.ytClient,
    ...(['ANDROID', 'WEB', 'TV'] as ClientProfile[]).filter((c) => c !== config.ytClient),
  ];
  let lastReason: FallbackReason | undefined;

  // 1. 主路径：多 client 重试
  for (const profile of attempts) {
    const res = await tryFetchCaptions(videoId, profile);
    if (res.ok) return res.result!;
    lastReason = res.reason;
  }

  // 2. 代理降级（可选）
  if (config.proxy) {
    try {
      const proxied = await tryFetchViaProxy(videoId, config);
      if (proxied.ok) return proxied.result!;
      lastReason = proxied.reason;
    } catch {
      lastReason = 'proxy_failed';
    }
  }

  // 3. 内置演示字幕兜底
  return {
    videoId,
    title: DEMO_CAPTIONS.title,
    segments: DEMO_CAPTIONS.segments,
    source: 'demo',
    fallbackReason: lastReason ?? 'no_captions_available',
  };
}

/** 单个 client 的完整字幕获取（player → timedtext） */
async function tryFetchCaptions(
  videoId: string,
  profile: ClientProfile,
): Promise<{ ok: boolean; result?: CaptionResult; reason?: FallbackReason }> {
  const ctx = CLIENT_CONTEXTS[profile];
  const playerRes = await fetchPlayerDirect(videoId, ctx);
  if (!playerRes.ok) return playerRes;

  return buildFromPlayer(playerRes.json!, videoId);
}

/** 直连 fetch youtubei/v1/player，含有效载荷校验 */
async function fetchPlayerDirect(
  videoId: string,
  ctx: { client: Record<string, unknown>; apiKey: string },
): Promise<{ ok: boolean; json?: PlayerJson; reason?: FallbackReason }> {
  const url = new URL(PLAYER_PATH, 'https://www.youtube.com');
  url.searchParams.set('key', ctx.apiKey);
  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: ctx.client },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
  } catch {
    return { ok: false, reason: 'youtube_network_error' };
  }
  return validatePlayer(resp.status, await resp.text());
}

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

/** 由 player 载荷提取字幕轨并获取 timedtext */
async function buildFromPlayer(
  json: PlayerJson,
  videoId: string,
): Promise<{ ok: boolean; result?: CaptionResult; reason?: FallbackReason }> {
  const tracks = json.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) return { ok: false, reason: 'youtube_no_caption_tracks' };

  const track =
    tracks.find((t) => t.languageCode === 'en' && t.baseUrl?.includes('kind=asr')) ??
    tracks.find((t) => t.languageCode?.startsWith('en')) ??
    tracks.find((t) => t.languageCode?.startsWith('zh')) ??
    tracks[0];
  if (!track.baseUrl) return { ok: false, reason: 'timedtext_empty_body' };

  const body = await fetchTimedTextDirect(track.baseUrl);
  if (!body) return { ok: false, reason: 'timedtext_empty_body' };

  const segments = parseTimedText(body);
  if (segments.length === 0) return { ok: false, reason: 'timedtext_empty_body' };

  return {
    ok: true,
    result: {
      videoId,
      title: json.videoDetails?.title ?? 'YouTube 视频',
      segments,
      source: 'youtube',
    },
  };
}

/** 直连 fetch timedtext（fmt=json3），空 body 视为失败 */
async function fetchTimedTextDirect(baseUrl: string): Promise<string | null> {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', 'json3');
  try {
    const resp = await fetch(url.toString());
    if (!resp.ok) return null;
    const text = await resp.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** 走代理隧道：POST player + GET timedtext */
async function tryFetchViaProxy(
  videoId: string,
  config: Config,
): Promise<{ ok: boolean; result?: CaptionResult; reason?: FallbackReason }> {
  const ctx = CLIENT_CONTEXTS.ANDROID;
  const url = new URL(PLAYER_PATH, 'https://www.youtube.com');
  url.searchParams.set('key', ctx.apiKey);
  const path = `${url.pathname}?${url.searchParams.toString()}`;

  const player = await httpsRequestViaProxy(
    config,
    'POST',
    TIMEDTEXT_HOST,
    path,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ context: { client: ctx.client }, videoId, contentCheckOk: true, racyCheckOk: true }),
  );
  const validated = validatePlayer(player.status, player.body);
  if (!validated.ok) return validated;

  const json = validated.json!;
  const tracks = json.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) return { ok: false, reason: 'youtube_no_caption_tracks' };

  const track =
    tracks.find((t) => t.languageCode === 'en' && t.baseUrl?.includes('kind=asr')) ??
    tracks.find((t) => t.languageCode?.startsWith('en')) ??
    tracks[0];
  if (!track.baseUrl) return { ok: false, reason: 'timedtext_empty_body' };

  const ttUrl = new URL(track.baseUrl);
  ttUrl.searchParams.set('fmt', 'json3');
  const tt = await httpsRequestViaProxy(
    config,
    'GET',
    TIMEDTEXT_HOST,
    `${ttUrl.pathname}?${ttUrl.searchParams.toString()}`,
  );
  if (tt.status !== 200 || !tt.body.trim()) return { ok: false, reason: 'timedtext_empty_body' };

  const segments = parseTimedText(tt.body);
  if (segments.length === 0) return { ok: false, reason: 'timedtext_empty_body' };

  return {
    ok: true,
    result: {
      videoId,
      title: json.videoDetails?.title ?? 'YouTube 视频',
      segments,
      source: 'proxy',
    },
  };
}

/** 解析 timedtext JSON3 → 时间戳+文本数组 */
export function parseTimedText(raw: string): CaptionSegment[] {
  try {
    const data = JSON.parse(raw);
    const events: { a?: { segs?: { utf8?: string }[] }[]; t?: number }[] = data?.events ?? [];
    const out: CaptionSegment[] = [];
    for (const ev of events) {
      const segs = ev?.a ?? [];
      const text = segs.map((s) => s?.segs?.map((x) => x?.utf8 ?? '').join('') ?? '').join('');
      if (!text.trim()) continue;
      out.push({ time: formatTime(ev.t ?? 0), text: text.trim() });
    }
    return out;
  } catch {
    return [];
  }
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
