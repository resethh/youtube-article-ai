#!/usr/bin/env node
/**
 * Gemini 503 / 接口连通性测试脚本
 *
 * 用于复现并诊断类似错误：
 *   生成失败：Gemini 流式请求失败 503: { "error": { "code": 503, ... high demand ... } }
 *   http://127.0.0.1:8787/api/article
 *
 * 两种模式：
 *   1) gemini —— 绕过 Worker，直连 Gemini streamGenerateContent，
 *                确认 503 是否来自 Google 上游（多数情况下是上游瞬时过载，几分钟后自愈）。
 *   2) worker —— 端到端走本地 wrangler dev 的 POST /api/article，解析 SSE 事件流。
 *
 * 用法：
 *   node test/api-test.mjs worker [<youtube-url>] [--requirement "…"] [--host http://127.0.0.1:8787] [--retries 3]
 *   node test/api-test.mjs gemini [--retries 5] [--wait-ms 1000] [--model gemini-3.8-flash] [--no-proxy]
 *
 * 配置：自动读取 .dev.vars 中的 GEMINI_API_KEY / GEMINI_MODEL / PROXY_HOST / PROXY_PORT，
 *       默认与 wrangler dev 一样走本地代理（Clash 等），可用 --no-proxy 关闭。
 * 退出码：0 成功；1 上游失败（或所有重试失败）；2 参数/环境错误。
 */
import { connect } from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const DEV_VARS = path.join(root, '.dev.vars');

// ---------------- 工具 ----------------

const isTty = process.stdout.isTTY === true;
const color = {
  red: (s) => (isTty ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (isTty ? `\x1b[32m${s}\x1b[0m` : s),
  dim: (s) => (isTty ? `\x1b[2m${s}\x1b[0m` : s),
  yellow: (s) => (isTty ? `\x1b[33m${s}\x1b[0m` : s),
};

/** 读取 .dev.vars（# 注释 / 空行跳过，KEY=VALUE 解析） */
function loadDevVars() {
  const vars = {};
  try {
    const text = fs.readFileSync(DEV_VARS, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    /* 文件不存在则留空，调用处自行报错 */
  }
  return vars;
}

/** 从 .dev.vars 推导代理配置（与 wrangler dev 行为一致） */
function proxyFromVars(vars) {
  const host = vars.PROXY_HOST?.trim();
  const port = Number.parseInt(vars.PROXY_PORT ?? '0', 10);
  if (!host || !port) return null;
  return { host, port, user: vars.PROXY_USER?.trim() || undefined, pass: vars.PROXY_PASS?.trim() || undefined };
}

/** 通过 HTTP 代理建立 CONNECT 隧道，返回已做 TLS 握手的 socket */
function openTunnel(proxyHost, proxyPort, host, port = 443) {
  return new Promise((resolve, reject) => {
    const plain = connect({ host: proxyHost, port: proxyPort });
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      plain.removeListener('data', onData);
      const head = buf.slice(0, idx);
      const leftover = Buffer.from(buf.slice(idx + 4), 'latin1');
      const m = /^HTTP\/1\.[01] (\d+)/.exec(head);
      if (!m || Number(m[1]) !== 200) {
        plain.destroy();
        reject(new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0]}`));
        return;
      }
      if (leftover.length) plain.unshift(leftover); // 归还与响应同帧的 TLS ServerHello
      const socket = tls.connect({ socket: plain, servername: host });
      socket.once('secureConnect', () => resolve(socket));
      socket.once('error', (e) => reject(new Error(`TLS 握手失败: ${e.message}`)));
    };
    let buf = '';
    plain.on('data', onData);
    plain.on('error', (e) => reject(new Error(`代理连接失败: ${e.message}`)));
    plain.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`);
  });
}

/** 走代理隧道发起 HTTPS 请求：读到响应完整（content-length / chunked 终止块 / EOF）即返回；流中断标记 truncated */
function requestThroughProxy(proxy, method, host, pathname, headers = {}, body) {
  return (async () => {
    const sock = await openTunnel(proxy.host, proxy.port, host, 443);
    const hs = { Host: host, Connection: 'close', ...headers };
    let head = `${method} ${pathname} HTTP/1.1\r\n`;
    head += Object.entries(hs).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    if (body) head += `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n`;
    head += '\r\n';
    sock.write(head + (body ?? ''));

    let raw = Buffer.alloc(0);
    let eof = false;
    try {
      for await (const c of sock) {
        raw = Buffer.concat([raw, c]);
        if (hasCompleteBody(raw)) break;
      }
    } catch {
      eof = true; // 流被上游/代理中途切断——拿到多少算多少
    }
    const sep = raw.indexOf('\r\n\r\n');
    if (sep < 0) throw new Error('响应缺少头部分隔');
    const headText = raw.slice(0, sep).toString('utf8');
    const status = Number.parseInt(headText.split(' ')[1] ?? '0', 10);
    let bodyBuf = raw.slice(sep + 4);
    if (/\bchunked\b/i.test(headText)) {
      bodyBuf = decodeChunked(bodyBuf);
      if (eof && !chunkedComplete(raw, sep + 4)) eof = true;
    }
    return { status, body: bodyBuf.toString('utf8'), truncated: eof };
  })();
}

/** 判断已收到的响应体是否完整：content-length 读满 或 chunked 见到终止块；否则视为依赖 EOF */
function hasCompleteBody(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return false;
  const headText = raw.slice(0, sep).toString('utf8');
  const cl = /^content-length:\s*(\d+)/im.exec(headText);
  if (cl) return raw.length >= sep + 4 + Number(cl[1]);
  if (/\bchunked\b/i.test(headText)) return chunkedComplete(raw, sep + 4);
  return false; // 无长度信息 → 等 EOF
}

/** 从 body 起始位置检查 chunked 是否收到终止块（0 长度 chunk + 尾部 CRLF） */
function chunkedComplete(raw, bodyStart) {
  return /^0\r\n\r\n|^0;[^\r\n]*\r\n\r\n/.test(raw.subarray(bodyStart).toString('latin1'));
}

/** 解码 chunked transfer-encoding 的响应体（返回去除 chunk 帧后的字节） */
function decodeChunked(raw) {
  const out = [];
  let i = 0;
  for (;;) {
    let eol = raw.indexOf('\r\n', i);
    if (eol < 0) break;
    const size = Number.parseInt(raw.slice(i, eol).toString('utf8').split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    i = eol + 2;
    out.push(raw.subarray(i, i + size));
    i += size + 2; // 跳过 chunk 数据后的 CRLF
  }
  return Buffer.concat(out);
}

/** 从 SSE 文本中提取候选文本增量 */
function extractSseText(body) {
  const out = [];
  for (const frame of body.split('\n\n')) {
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try {
      const p = JSON.parse(line.slice(5).trim());
      if (!p) continue;
      const parts = p?.candidates?.[0]?.content?.parts ?? [];
      // 汇总所有 parts 的 text（含 thinking 之后的正式回答）；跳过 thought/工具块易混淆，仅取纯文本
      for (const part of parts) {
        if (part && typeof part?.text === 'string' && !part?.thought && part.text) out.push(part.text);
      }
    } catch { /* 单帧损坏忽略 */ }
  }
  return out.join('');
}

function summarize(s, n = 200) {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

/** 从 applyGenerateContent 的 JSON 响应中抽取可视文本（candidates[0].content.parts[].text） */
function extractJsonText(body) {
  try {
    const p = JSON.parse(body);
    const parts = p?.candidates?.[0]?.content?.parts ?? [];
    return parts.filter((x) => x && typeof x?.text === 'string' && !x?.thought && x.text).map((x) => x.text).join('');
  } catch {
    return '';
  }
}

// ---------------- gemini 直连探测 ----------------

/**
 * 调用 Gemini：
 *  - stream=true   :generateContent?alt=sse（复刻 app 主文章路径）
 *  - stream=false  :generateContent（非流式，作为更稳的基线探测）
 * 返回 { status, body, truncated? }
 */
async function geminiRequest(apiKey, model, prompt, proxy, { stream = true } = {}) {
  const pathname = stream
    ? `/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    : `/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // 注意：maxOutputTokens 太小（如 64）会被 thinking 消耗光 → 正式回答为空，误判为异常
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  });
  if (proxy) {
    return requestThroughProxy(proxy, 'POST', 'generativelanguage.googleapis.com', pathname, { 'Content-Type': 'application/json' }, payload);
  }
  const resp = await fetch(`https://generativelanguage.googleapis.com${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(60000),
  });
  return { status: resp.status, body: await resp.text() };
}

/** 指数退避重试；任一成功即返回 true */
async function probeGemini({ apiKey, model, proxy, retries, waitMs, stream }) {
  const prompt = '请用一句话回复：这是一次连通性测试。';
  for (let i = 1; i <= retries + 1; i++) {
    const t0 = Date.now();
    try {
      const { status, body, truncated } = await geminiRequest(apiKey, model, prompt, proxy, { stream });
      const ms = Date.now() - t0;
      if (status === 200) {
        const text = stream ? extractSseText(body) : extractJsonText(body);
        if (truncated) {
          console.log(color.yellow(`⚠️  第 ${i}/${retries + 1} 次 HTTP 200 但流被中途切断（${ms}ms），拿到 ${text.length} 字`));
          continue; // 截断不算成功，继续重试
        }
        if (!text) console.log(color.yellow(`   提示: HTTP 200 但未解析出文本，原始响应前 200 字: ${summarize(body, 200)}`));
        console.log(color.green(`✅ 第 ${i}/${retries + 1} 次成功  HTTP 200 (${ms}ms)  返回 ${text.length} 字：${summarize(text, 60)}`));
        return true;
      }
      console.log(color.red(`❌ 第 ${i}/${retries + 1} 次失败  HTTP ${status} (${ms}ms)  ${summarize(body)}`));
    } catch (e) {
      console.log(color.red(`❌ 第 ${i}/${retries + 1} 次异常  (${Date.now() - t0}ms)  ${e.message}`));
    }
    if (i <= retries) {
      const wait = Math.min(waitMs * 2 ** (i - 1), 30000);
      console.log(color.dim(`   等待 ${wait}ms 后重试…`));
      await sleep(wait);
    }
  }
  return false;
}

// ---------------- worker 端到端 ----------------

/** 消费 Web ReadableStream 并按 \n\n 拆帧 SSE，逐事件回调 */
async function readSse(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try { onData(JSON.parse(line.slice(5).trim())); } catch { /* 损坏帧忽略 */ }
    }
  }
  if (buf.trim()) {
    const line = buf.split('\n').find((l) => l.startsWith('data:'));
    if (line) { try { onData(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ } }
  }
}

/** 跑一次 /api/article，成功返回 true，SSE error 事件返回 false */
async function runWorkerOnce(host, url, requirement) {
  const t0 = Date.now();
  const resp = await fetch(`${host}/api/article`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, requirement: requirement || undefined }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.log(color.red(`HTTP ${resp.status}: ${summarize(text)}`));
    return false;
  }
  let ok = true;
  let deltaCount = 0;
  await readSse(resp.body, (ev) => {
    switch (ev.type) {
      case 'chapter':
        console.log(color.dim(`   章节 ${ev.index}: ${ev.title}`));
        break;
      case 'delta':
        deltaCount++;
        break;
      case 'meta':
        console.log(color.green(`   完成: 「${ev.title}」 source=${ev.source} session=${ev.sessionId} 章节数=${ev.chapters.length}`));
        if (ev.fallbackReason) console.log(color.yellow(`   字幕降级原因: ${ev.fallbackReason}`));
        break;
      case 'error':
        ok = false;
        console.log(color.red(`   SSE error: ${ev.message}`));
        break;
      default:
        console.log(color.dim(`   未知事件: ${ev.type}`));
    }
  });
  if (ok) console.log(color.green(`✅ 生成成功  (${Date.now() - t0}ms)  增量 ${deltaCount} 段`));
  return ok;
}

async function probeWorker({ host, url, requirement, retries }) {
  for (let i = 1; i <= retries + 1; i++) {
    console.log(color.dim(`—— 第 ${i}/${retries + 1} 次请求 ${host}/api/article`));
    try {
      const ok = await runWorkerOnce(host, url, requirement);
      if (ok) return true;
    } catch (e) {
      console.log(color.red(`异常: ${e.message}`));
    }
    if (i <= retries) {
      const wait = 2000 * 2 ** (i - 1);
      console.log(color.dim(`   等待 ${wait}ms 重试…`));
      await sleep(wait);
    }
  }
  return false;
}

// ---------------- 入口 ----------------

function argValue(args, name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}
function hasFlag(args, name) {
  return args.includes(name);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const vars = loadDevVars();
  const apiKey = vars.GEMINI_API_KEY;

  if (mode === 'gemini') {
    if (!apiKey) {
      console.error(color.red('GEMINI_API_KEY 未配置。请检查 .dev.vars（本地用）或运行 wrangler secret put GEMINI_API_KEY（线上）。'));
      process.exit(2);
    }
    const model = argValue(args, '--model', vars.GEMINI_MODEL || 'gemini-3.8-flash');
    const retries = Number(argValue(args, '--retries', '5'));
    const waitMs = Number(argValue(args, '--wait-ms', '1000'));
    const stream = !hasFlag(args, '--non-stream');
    const proxy = hasFlag(args, '--no-proxy') ? null : proxyFromVars(vars);
    if (proxy) console.log(color.dim(`代理: ${proxy.host}:${proxy.port}（与 wrangler dev 一致）  model=${model}  重试 ${retries} 次  模式=${stream ? '流式' : '非流式'}`));
    else console.log(color.dim(`直连（无代理）  model=${model}  重试 ${retries} 次  模式=${stream ? '流式' : '非流式'}`));
    console.log(color.dim('提示: HTTP 503 + "high demand" = Google 上游瞬时过载，通常几分钟后自愈，重试即可。'));

    const ok = await probeGemini({ apiKey, model, proxy, retries, waitMs, stream });
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (mode === 'worker') {
    const host = argValue(args, '--host', 'http://127.0.0.1:8787');
    const requirement = argValue(args, '--requirement', '');
    const retries = Number(argValue(args, '--retries', '3'));
    // 第一个非 -- 开头的裸参数为 YouTube URL；跳过 --key value 型的值，避免把 --host 的值误当 URL
    let url = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (!a.startsWith('--')) { url = a; break; }
      if (['--host', '--requirement', '--retries'].includes(a)) i++; // 跳过一个参数值
    }
    url = url ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    console.log(color.dim(`URL: ${url}   若 YouTube 字幕获取失败将自动使用内置演示字幕，Gemini 调用不受影响。`));

    const ok = await probeWorker({ host, url, requirement, retries });
    process.exitCode = ok ? 0 : 1;
    return;
  }

  console.log(`用法:
  node test/api-test.mjs worker [<youtube-url>] [--requirement "…"] [--host http://127.0.0.1:8787] [--retries 3]
  node test/api-test.mjs gemini  [--retries 5] [--wait-ms 1000] [--model gemini-3.8-flash] [--no-proxy] [--non-stream]

退出码: 0 成功 / 1 失败 / 2 参数或环境错误`);
  process.exit(2);
}

main();
