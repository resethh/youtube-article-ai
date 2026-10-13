#!/usr/bin/env node
/**
 * fetch_youtube_transcript.mjs
 * 参考 baoyu-youtube-transcript skill 实现的 YouTube 字幕获取脚本（无第三方依赖，Node >= 18）。
 * 流程: watch 页抽 InnerTube session -> 多 client 重试 /youtubei/v1/player 取 captionTracks
 *       -> 按语言优先级取 timedtext 原文(自动识别 json3/xml/vtt) -> 段落化输出 md/srt 并落盘
 *       -> 失败降级 yt-dlp(若可用)
 * 网络: 默认直连; 可用 --proxy 或 HTTPS_PROXY/HTTP_PROXY 指定 HTTP 代理(内置 CONNECT 隧道, 适配 Clash)。
 *
 * 用法:
 *   node test/fetch_youtube_transcript.mjs <url|videoId> [--languages en,zh-Hans] [--format text|srt]
 *        [--no-timestamps] [--proxy http://127.0.0.1:7897] [-o 输出文件]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tcpConnect } from "node:net";
import tls from "node:tls";

const WATCH_URL = "https://www.youtube.com/watch?v=";
const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player";
const WATCH_PAGE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const DEFAULT_WEB_CLIENT_VERSION = "2.20260320.08.00";
const REQUEST_TIMEOUT_MS = 30_000;
const YT_DLP_MAX_BUFFER = 32 * 1024 * 1024;

/** 备用 client 身份，参考 skill 的 INNER_TUBE_CLIENTS */
const CLIENTS = [
  {
    id: "android",
    clientName: "ANDROID",
    clientHeaderName: "3",
    clientVersion: "20.10.38",
    userAgent:
      "com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US; Pixel 8 Pro; Build/AP1A.240405.002)",
    extraContext: { clientFormFactor: "SMALL_FORM_FACTOR", androidSdkVersion: 34, osName: "Android", osVersion: "14", platform: "MOBILE" },
  },
  {
    id: "web",
    clientName: "WEB",
    clientHeaderName: "1",
    userAgent: WATCH_PAGE_USER_AGENT,
  },
  {
    id: "ios",
    clientName: "IOS",
    clientHeaderName: "5",
    clientVersion: "20.10.4",
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X; en_US)",
    extraContext: { deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.0.22D5054f", platform: "MOBILE" },
  },
];

/* ---------------- 基础工具 ---------------- */

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeError(error) {
  if (error instanceof Error) {
    if (error.code) return error;
    const lower = (error.message || "").toLowerCase();
    if (lower.includes("bot detected")) error.code = "BOT_DETECTED";
    else if (lower.includes("age restricted")) error.code = "AGE_RESTRICTED";
    else if (lower.includes("unavailable")) error.code = "VIDEO_UNAVAILABLE";
    else if (lower.includes("transcripts disabled")) error.code = "TRANSCRIPTS_DISABLED";
    else if (lower.includes("no transcript")) error.code = "NO_TRANSCRIPT";
    else if (lower.includes("ip blocked") || lower.includes("recaptcha") || lower.includes("429")) error.code = "IP_BLOCKED";
    else if (lower.includes("api key")) error.code = "PAGE_FETCH_FAILED";
    return error;
  }
  return makeError(String(error), "UNKNOWN");
}

function shouldTryAlternative(error) {
  const code = normalizeError(error).code;
  return ["BOT_DETECTED", "IP_BLOCKED", "INNERTUBE_REJECTED", "AGE_RESTRICTED", "VIDEO_UNAVAILABLE"].includes(code);
}

/** 参考 skill shared.ts 的 extractVideoId */
function extractVideoId(input) {
  const text = String(input).replace(/\\/g, "").trim();
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return text;
}

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, "");
}

function htmlUnescape(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function ts(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function tsMs(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/* ---------------- 网络层（支持 HTTP 代理 CONNECT 隧道） ---------------- */

let proxyUrl = "";

/** 通过 HTTP 代理 CONNECT 建立到目标主机的 TLS 隧道 */
function tunnelToProxy(targetOptions, callback) {
  const proxy = new URL(proxyUrl);
  const host = targetOptions.host;
  const port = targetOptions.port || 443;
  let done = false;
  const finish = (err, socket) => {
    if (done) return;
    done = true;
    if (err) callback(err);
    else callback(null, socket);
  };

  const socket = tcpConnect({ host: proxy.hostname, port: Number(proxy.port || 7890) }, () => {
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
  });
  socket.setTimeout(15_000, () => socket.destroy(new Error(`代理连接超时: ${proxy.hostname}:${proxy.port}`)));
  socket.on("error", (err) => finish(err));

  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const idx = buffer.indexOf("\r\n\r\n");
    if (idx === -1) return;
    socket.removeListener("data", onData);
    const statusLine = buffer.subarray(0, idx).toString().split("\r\n")[0];
    if (!/^HTTP\/1\.[01]\s+200/.test(statusLine)) {
      socket.destroy();
      finish(makeError(`代理 CONNECT 失败: ${statusLine}`));
      return;
    }
    const tlsSocket = tls.connect({ socket, servername: host, host, port }, () => finish(null, tlsSocket));
    tlsSocket.on("error", (err) => finish(err));
  };
  socket.on("data", onData);
}

/** 通用 HTTP(S) 请求：返回 { status, headers, text }，自动跟随重定向（最多 5 次），网络错误自动重试 */
function request(url, { method = "GET", headers = {}, body, timeout = REQUEST_TIMEOUT_MS, maxRedirects = 5, retries = 2 } = {}) {
  return new Promise((resolve, reject) => {
    const run = (currentUrl, redirectsLeft, currentHeaders, currentBody, currentMethod) => {
      const target = new URL(currentUrl);
      const lib = target.protocol === "http:" ? httpRequest : httpsRequest;
      const req = lib(
        {
          host: target.hostname,
          port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
          method: currentMethod,
          path: target.pathname + target.search,
          headers: currentHeaders,
          timeout,
          ...(proxyUrl ? { createConnection: tunnelToProxy } : {}),
        },
        (res) => {
          const redirectStatus = [301, 302, 303, 307, 308];
          if (redirectStatus.includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume(); // 丢弃重定向响应体
            const nextUrl = new URL(res.headers.location, target).toString();
            const nextMethod = res.statusCode === 303 && currentMethod !== "GET" ? "GET" : currentMethod;
            const nextHeaders = nextMethod === "GET" ? { ...currentHeaders, "content-type": undefined, "content-length": undefined } : currentHeaders;
            run(nextUrl, redirectsLeft - 1, nextHeaders, nextMethod === "GET" ? undefined : currentBody, nextMethod);
            return;
          }
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        }
      );
      req.on("timeout", () => req.destroy(new Error(`请求超时（>${timeout / 1000}s）: ${currentUrl}`)));
      req.on("error", (err) => {
        const wrapped = new Error(`请求失败: ${err.cause?.code || err.message}（${currentUrl}）`);
        wrapped.retryable = true;
        reject(wrapped);
      });
      if (currentBody) req.write(currentBody);
      req.end();
    };

    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      run(url, maxRedirects, headers, body, method);
    };
    const originalReject = reject;
    reject = (error) => {
      if (error.retryable && attempts <= retries) {
        setTimeout(attempt, 500);
        return;
      }
      originalReject(error);
    };
    attempt();
  });
}

/* ---------------- Step 1: watch 页抽取 InnerTube session ---------------- */

async function fetchHtml(videoId) {
  const watchUrl = `${WATCH_URL}${videoId}&hl=en&persist_hl=1&has_verified=1&bpctr=9999999999`;
  const baseHeaders = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent": WATCH_PAGE_USER_AGENT,
  };
  const res = await request(watchUrl, { headers: baseHeaders });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} 获取 watch 页面`);
  if (res.text.includes('action="https://consent.youtube.com/s"')) {
    const consentValue = res.text.match(/name="v" value="(.*?)"/);
    if (!consentValue) throw new Error("无法创建 consent cookie");
    const consentRes = await request(watchUrl, {
      headers: { ...baseHeaders, Cookie: `CONSENT=YES+${consentValue[1]}` },
    });
    if (consentRes.status !== 200) throw new Error(`HTTP ${consentRes.status} 获取 watch 页面 (consent)`);
    return consentRes.text;
  }
  return res.text;
}

function extractSession(html, videoId) {
  const apiKey = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1];
  if (!apiKey) {
    if (html.includes('class="g-recaptcha"')) throw makeError(`IP 被限流（reCAPTCHA）: ${videoId}`, "IP_BLOCKED");
    throw makeError(`无法从页面提取 API key: ${videoId}`, "PAGE_FETCH_FAILED");
  }
  const webClientVersion =
    html.match(/"INNERTUBE_CLIENT_VERSION":\s*"([^"]+)"/)?.[1] ||
    html.match(/"clientVersion":"([^"]+)"/)?.[1] ||
    DEFAULT_WEB_CLIENT_VERSION;
  const visitorData =
    html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || html.match(/"visitorData":"([^"]+)"/)?.[1] || "";
  return { apiKey, webClientVersion, visitorData };
}

/* ---------------- Step 2: InnerTube player 接口 ---------------- */

function buildInnerTubeContext(client, session, videoId) {
  return {
    context: {
      client: {
        hl: "en",
        gl: "US",
        utcOffsetMinutes: 0,
        visitorData: session.visitorData,
        clientName: client.clientName,
        clientVersion: client.clientVersion || session.webClientVersion,
        ...(client.extraContext || {}),
      },
      request: { useSsl: true },
    },
    videoId,
  };
}

async function fetchInnertubeData(videoId, session, client) {
  const clientVersion = client.clientVersion || session.webClientVersion;
  const headers = {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Origin: "https://www.youtube.com",
    Referer: `${WATCH_URL}${videoId}`,
    "User-Agent": client.userAgent,
    "X-YouTube-Client-Name": client.clientHeaderName || "1",
    "X-YouTube-Client-Version": clientVersion,
  };
  if (session.visitorData) headers["X-Goog-Visitor-Id"] = session.visitorData;
  const res = await request(`${INNERTUBE_URL}?key=${session.apiKey}&prettyPrint=false`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildInnerTubeContext(client, session, videoId)),
  });
  if (res.status === 429) throw makeError(`IP 被限流（HTTP 429）: ${videoId}`, "IP_BLOCKED");
  if (res.status !== 200) throw makeError(`InnerTube API HTTP ${res.status}`, "INNERTUBE_REJECTED");
  return JSON.parse(res.text);
}

function assertPlayability(data, videoId) {
  const playabilityStatus = data?.playabilityStatus;
  if (!playabilityStatus) return;
  const { status, reason = "" } = playabilityStatus;
  if (status === "OK" || !status) return;
  if (status === "LOGIN_REQUIRED" && /bot/i.test(reason)) throw makeError(`请求被拦截（bot detected）: ${videoId}`, "BOT_DETECTED");
  if (status === "LOGIN_REQUIRED" && /inappropriate/i.test(reason)) throw makeError(`年龄受限: ${videoId}`, "AGE_RESTRICTED");
  if (status === "ERROR" && /unavailable/i.test(reason)) throw makeError(`视频不可用: ${videoId}`, "VIDEO_UNAVAILABLE");
  const subreason =
    playabilityStatus.errorScreen?.playerErrorMessageRenderer?.subreason?.runs?.map((run) => run.text).join("") || "";
  throw new Error(`视频无法播放（${videoId}）: ${reason} ${subreason}`.trim());
}

function extractCaptionTracks(data, videoId) {
  assertPlayability(data, videoId);
  const captionsJson = data?.captions?.playerCaptionsTracklistRenderer;
  if (!captionsJson || !captionsJson.captionTracks) {
    throw makeError(`该视频没有字幕（Transcripts disabled）: ${videoId}`, "TRANSCRIPTS_DISABLED");
  }
  return (captionsJson.captionTracks || []).map((track) => ({
    languageCode: track.languageCode,
    language: track.name?.runs?.[0]?.text || track.name?.simpleText || track.languageCode,
    isGenerated: track.kind === "asr",
    isTranslatable: !!track.isTranslatable,
    baseUrl: track.baseUrl || "",
  }));
}

/* ---------------- Step 3: 字幕原文拉取与解析 ---------------- */

/** 参考 skill transcript.ts 的 parseTranscriptJson3 */
function parseTranscriptJson3(text) {
  const data = JSON.parse(text);
  const events = Array.isArray(data?.events) ? data.events : [];
  const snippets = [];
  for (const event of events) {
    const segs = Array.isArray(event?.segs) ? event.segs : [];
    const textParts = segs.map((seg) => htmlUnescape(String(seg?.utf8 || "").replace(/\n+/g, " ").trim())).filter(Boolean);
    const merged = textParts.join(" ").replace(/ {2,}/g, " ").trim();
    if (!merged) continue;
    snippets.push({ text: merged, start: Number(event?.tStartMs || 0) / 1000, duration: Number(event?.dDurationMs || 0) / 1000 });
  }
  return snippets;
}

/** 参考 skill transcript.ts 的 parseTranscriptXml */
function parseTranscriptXml(xml) {
  const snippets = [];
  const pattern = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const raw = match[3];
    if (!raw) continue;
    snippets.push({ text: htmlUnescape(stripTags(raw)), start: parseFloat(match[1]), duration: parseFloat(match[2] || "0") });
  }
  return snippets;
}

function parseWebVtt(vtt) {
  const blocks = vtt.replace(/^WEBVTT\s*/m, "").trim().split(/\n\n+/);
  const snippets = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const tsLine = lines.find((line) => line.includes("-->"));
    if (!tsLine) continue;
    const match = tsLine.match(/(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/);
    if (!match) continue;
    const start = (match[1] ? parseInt(match[1]) : 0) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
    const end = (match[5] ? parseInt(match[5]) : 0) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
    const text = htmlUnescape(stripTags(lines.slice(lines.indexOf(tsLine) + 1).join(" ").replace(/\s+/g, " ").trim()));
    if (!text) continue;
    snippets.push({ text, start, duration: end - start });
  }
  return snippets;
}

/** 参考 skill transcript.ts 的 parseTranscriptPayload（自动识别格式） */
function parseTranscriptPayload(payload, url) {
  const normalized = payload.trimStart();
  if (url.includes("fmt=json3") || normalized.startsWith("{")) return parseTranscriptJson3(payload);
  if (normalized.startsWith("WEBVTT")) return parseWebVtt(payload);
  return parseTranscriptXml(payload);
}

async function fetchTranscriptSnippets(track, videoId) {
  // baseUrl 可能带 fmt=srv3（protobuf，难解析），强制 json3 便于解析
  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "json3");
  const res = await request(url.toString(), {
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": WATCH_PAGE_USER_AGENT,
      Referer: `${WATCH_URL}${videoId}`,
    },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} 获取字幕正文`);
  if (process.env.YT_DEBUG) {
    console.error(`[debug] track language=${track.languageCode} baseUrl=${track.baseUrl.slice(0, 220)}`);
    console.error(`[debug] status=${res.status} bodyLen=${res.text.length}`);
  }
  const snippets = parseTranscriptPayload(res.text, url.toString());
  if (!snippets.length && process.env.YT_DEBUG) console.error(`[debug] body head: ${res.text.slice(0, 400)}`);
  return snippets;
}

/* ---------------- Step 4: yt-dlp 降级路径（参考 skill youtube.ts） ---------------- */

function detectYtDlp() {
  const candidates = [
    { command: "yt-dlp", args: [] },
    { command: "uvx", args: ["--from", "yt-dlp", "yt-dlp"] },
    { command: "python3", args: ["-m", "yt_dlp"] },
    { command: "python", args: ["-m", "yt_dlp"] },
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.args, "--version"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function fetchViaYtDlp(videoId) {
  const command = detectYtDlp();
  if (!command) {
    throw makeError("直连被 YouTube 拦截，且未找到 yt-dlp 降级工具（可用 `pip install yt-dlp` 安装后重试）", "YT_DLP_UNAVAILABLE");
  }
  const args = [...command.args, "-J", "--skip-download", `${WATCH_URL}${videoId}`];
  if (proxyUrl) args.push("--proxy", proxyUrl);
  const result = spawnSync(command.command, args, { encoding: "utf8", maxBuffer: YT_DLP_MAX_BUFFER });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim() || `exit ${result.status}`;
    throw makeError(`yt-dlp 降级失败: ${detail}`, "YT_DLP_FAILED");
  }
  return JSON.parse(result.stdout);
}

function buildTracksFromYtDlp(info) {
  const extPriority = ["json3", "srv3", "srv2", "srv1", "ttml", "vtt"];
  const pickUrl = (entries) => {
    for (const ext of extPriority) {
      const entry = entries.find((e) => e.ext === ext && e.url);
      if (entry) return entry.url;
    }
    return entries.find((e) => e.url)?.url || "";
  };
  const tracks = [];
  const add = (languageCode, entries, isGenerated) => {
    const url = pickUrl(entries);
    if (!url) return;
    tracks.push({
      languageCode,
      language: entries.find((e) => e.name)?.name || languageCode,
      isGenerated,
      isTranslatable: false,
      baseUrl: url,
    });
  };
  for (const [languageCode, entries] of Object.entries(info.subtitles || {})) add(languageCode, entries, false);
  for (const [languageCode, entries] of Object.entries(info.automatic_captions || {})) add(languageCode, entries, true);
  return tracks;
}

/* ---------------- Step 5: 语言选择与输出 ---------------- */

function findTrack(tracks, languages) {
  const preferred = languages.map((code) => code.trim()).filter(Boolean);
  for (const code of preferred) {
    const found = tracks.find((track) => track.languageCode === code);
    if (found) return found;
  }
  const available = tracks.map((track) => `${track.languageCode} (${track.language})`).join(", ");
  throw makeError(`未找到语言 [${preferred.join(", ")}] 的字幕。可用: ${available || "无"}`, "NO_TRANSCRIPT");
}

/** 按时间间隔把 snippet 合并为段落 */
function groupParagraphs(snippets, maxGap = 1.5, maxChars = 300) {
  const paragraphs = [];
  let buffer = [];
  snippets.forEach((snippet, index) => {
    buffer.push(snippet);
    const next = snippets[index + 1];
    const gap = next ? next.start - (snippet.start + snippet.duration) : Infinity;
    const chars = buffer.reduce((sum, item) => sum + item.text.length, 0);
    if (!next || gap > maxGap || chars >= maxChars) {
      paragraphs.push({
        text: buffer.map((item) => item.text).join(" ").replace(/ {2,}/g, " ").trim(),
        start: buffer[0].start,
        end: snippet.start + snippet.duration,
      });
      buffer = [];
    }
  });
  return paragraphs;
}

function formatMarkdown({ videoId, title, channel, languageCode, isGenerated, paragraphs, timestamps }) {
  let output = "---\n";
  output += `title: ${title}\n`;
  output += `channel: ${channel}\n`;
  output += `url: https://www.youtube.com/watch?v=${videoId}\n`;
  output += `language: ${languageCode}\n`;
  output += `generated: ${isGenerated}\n`;
  output += "---\n\n";
  output += `# ${title}\n\n`;
  for (const paragraph of paragraphs) {
    output += timestamps ? `${paragraph.text} [${ts(paragraph.start)} → ${ts(paragraph.end)}]\n\n` : `${paragraph.text}\n\n`;
  }
  return output.trimEnd() + "\n";
}

function formatSrt(snippets) {
  const blocks = snippets.map((snippet, index) => {
    const start = tsMs(snippet.start);
    const end = tsMs(snippet.start + (snippet.duration || 0));
    return `${index + 1}\n${start} --> ${end}\n${snippet.text}`;
  });
  return blocks.join("\n\n") + "\n";
}

function printHelp() {
  console.log(`用法: node test/fetch_youtube_transcript.mjs <url|videoId> [选项]

选项:
  --languages <codes>   语言优先级，逗号分隔（默认: en）
  --format <fmt>        输出格式: text | srt（默认: text）
  --no-timestamps       不带时间戳
  --proxy <url>         HTTP 代理，如 http://127.0.0.1:7897（也支持 HTTPS_PROXY 环境变量）
  -o, --output <path>   输出文件路径（默认: youtube-transcript/<videoId>/transcript.md|srt）
  -h, --help            显示帮助`);
}

function parseArgs(argv) {
  const opts = { videoIds: [], languages: ["en"], format: "text", timestamps: true, output: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--languages") {
      const value = argv[++i];
      if (value) opts.languages = value.split(",").map((item) => item.trim());
    } else if (arg === "--format") {
      const value = argv[++i]?.toLowerCase();
      if (value === "text" || value === "srt") opts.format = value;
      else {
        console.error(`无效格式: ${value}（可选 text | srt）`);
        process.exit(1);
      }
    } else if (arg === "--no-timestamps") {
      opts.timestamps = false;
    } else if (arg === "--proxy") {
      proxyUrl = argv[++i] || "";
    } else if (arg === "-o" || arg === "--output") {
      opts.output = argv[++i] || "";
    } else if (!arg.startsWith("-")) {
      opts.videoIds.push(extractVideoId(arg));
    }
  }
  if (!opts.videoIds.length) {
    console.error("错误: 至少需要一个视频 URL 或 videoId");
    printHelp();
    process.exit(1);
  }
  return opts;
}

async function fetchTranscript(videoId, opts) {
  let tracks = null;
  let meta = { videoId, title: "", channel: "" };

  // 主路径: watch 页 session + 多 client 重试
  try {
    const html = await fetchHtml(videoId);
    const session = extractSession(html, videoId);
    let lastError = null;
    for (const client of CLIENTS) {
      try {
        const data = await fetchInnertubeData(videoId, session, client);
        tracks = extractCaptionTracks(data, videoId);
        meta.title = data?.videoDetails?.title || "";
        meta.channel = data?.videoDetails?.author || "";
        break;
      } catch (error) {
        lastError = error;
        if (!shouldTryAlternative(error)) throw error;
      }
    }
    if (!tracks) throw lastError || new Error("未能获取字幕轨道");
  } catch (error) {
    // yt-dlp 降级
    const normalized = normalizeError(error);
    const fallbackable = ["BOT_DETECTED", "IP_BLOCKED", "INNERTUBE_REJECTED", "PAGE_FETCH_FAILED", "AGE_RESTRICTED", "VIDEO_UNAVAILABLE"];
    if (!fallbackable.includes(normalized.code)) throw error;
    console.warn(`直接请求失败（${normalized.message}），尝试 yt-dlp 降级…`);
    const info = fetchViaYtDlp(videoId);
    tracks = buildTracksFromYtDlp(info);
    meta.title = info.title || "";
    meta.channel = info.channel || info.uploader || "";
    if (!tracks.length) throw makeError(`该视频没有字幕: ${videoId}`, "TRANSCRIPTS_DISABLED");
  }

  const track = findTrack(tracks, opts.languages);
  const snippets = await fetchTranscriptSnippets(track, videoId);
  return { meta: { ...meta, languageCode: track.languageCode, isGenerated: track.isGenerated }, snippets };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!proxyUrl) {
    proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
    if (proxyUrl) console.warn(`使用环境变量代理: ${proxyUrl}`);
  }
  const videoId = opts.videoIds[0];

  const { meta, snippets } = await fetchTranscript(videoId, opts);

  const content =
    opts.format === "srt"
      ? formatSrt(snippets)
      : formatMarkdown({ ...meta, paragraphs: groupParagraphs(snippets), timestamps: opts.timestamps });

  const defaultName = `transcript.${opts.format === "srt" ? "srt" : "md"}`;
  const outputPath = opts.output ? resolve(opts.output) : resolve(join("youtube-transcript", videoId, defaultName));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf8");

  console.log(content);
  console.log(`\n✔ 字幕已保存: ${outputPath}（${snippets.length} 条字幕片段, 语言 ${meta.languageCode}${meta.isGenerated ? ", 自动生成" : ""}）`);
}

try {
  await main();
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
