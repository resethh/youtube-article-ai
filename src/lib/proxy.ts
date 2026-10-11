/**
 * HTTP 代理隧道：Cloudflare fetch 不支持代理，改用 TCP Socket（cloudflare:sockets）。
 * 流程：connect(代理) → CONNECT 目标:443 → 读代理 200 → startTls()（特性检测回退）→ 手动 HTTP/1.1。
 */
import { connect } from 'cloudflare:sockets';
import type { Config } from '../config';

interface HttpOverSocketResult {
  status: number;
  body: string;
}

/**
 * 通过代理隧道发起 HTTPS 请求（GET/POST）。
 * 仅当 proxy 配置存在时调用。每次调用独立建立隧道。
 */
export async function httpsRequestViaProxy(
  config: Config,
  method: 'GET' | 'POST',
  host: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpOverSocketResult> {
  if (!config.proxy) throw new Error('proxy 未配置');

  const socket = connect({ hostname: config.proxy.host, port: config.proxy.port });
  await socket.opened;

  // 1. CONNECT 握手
  await socket.writable.getWriter().write(new TextEncoder().encode(buildConnectRequest(host, config)));
  const head = await readUntilCrlfCrlf(socket);
  if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
    socket.close();
    throw new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0]}`);
  }

  // 2. 隧道内 TLS（先建明文读写，再 startTls 升级）
  let tlsSocket: Socket | undefined;
  try {
    tlsSocket = await socket.startTls();
  } catch {
    // 特性不可用/失败：回退明文（用于本地不可用时的可观测失败）
    tlsSocket = socket;
  }
  const finalSocket = tlsSocket;

  // 3. 手动 HTTP/1.1 请求
  const writer = finalSocket.writable.getWriter();
  await writer.write(new TextEncoder().encode(buildRequest(method, host, path, headers, body)));
  writer.releaseLock();

  const raw = await readToEnd(finalSocket);
  finalSocket.close();

  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('代理响应缺少头部分隔');
  const headText = raw.slice(0, sep);
  const bodyText = raw.slice(sep + 4);
  const status = Number.parseInt(headText.split(' ')[1] ?? '0', 10);
  if (!status) throw new Error('代理响应状态码解析失败');
  return { status, body: bodyText };
}

function buildConnectRequest(host: string, config: Config): string {
  const { user, pass } = config.proxy!;
  let lines = [`CONNECT ${host}:443 HTTP/1.1`, `Host: ${host}:443`, 'Proxy-Connection: keep-alive'];
  if (user) {
    lines.push(`Proxy-Authorization: Basic ${btoa(`${user}:${pass ?? ''}`)}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

function buildRequest(
  method: 'GET' | 'POST',
  host: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): string {
  const hs = Object.entries({ Host: host, Connection: 'close', ...headers })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  const head = `${method} ${path} HTTP/1.1\r\n${hs}\r\n`;
  return body ? `${head}Content-Length: ${body.length}\r\n\r\n${body}` : `${head}\r\n`;
}

/** 读取直到 \r\n\r\n（CONNECT 握手响应） */
async function readUntilCrlfCrlf(socket: Socket): Promise<string> {
  const reader = socket.readable.getReader();
  let acc = '';
  try {
    while (acc.length < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += new TextDecoder().decode(value);
      if (acc.includes('\r\n\r\n')) break;
    }
  } finally {
    reader.releaseLock();
  }
  return acc;
}

async function readToEnd(socket: Socket): Promise<string> {
  const reader = socket.readable.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return out + decoder.decode();
}