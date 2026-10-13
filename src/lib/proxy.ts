/**
 * HTTP 代理隧道：Cloudflare fetch 不支持代理，改用 TCP Socket（cloudflare:sockets）。
 * 流程：connect(代理) → CONNECT 目标:443 → 读代理 200 → startTls()（特性检测回退）→ 手动 HTTP/1.1。
 */
import { connect } from 'cloudflare:sockets';
import type { ProxyConfig } from '../config';

interface HttpOverSocketResult {
  status: number;
  body: string;
  /** 响应头（供 Set-Cookie 等复用） */
  headers?: Record<string, string>;
}

/**
 * 通过代理隧道发起 HTTPS 请求（GET/POST）。
 * 仅当 proxy 配置存在时调用。每次调用独立建立隧道。
 */
export async function httpsRequestViaProxy(
  proxy: ProxyConfig,
  method: 'GET' | 'POST',
  host: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpOverSocketResult> {
  // 阶段 1：TCP 连接代理
  let socket: Socket;
  try {
    socket = connect(
      { hostname: proxy.host, port: proxy.port },
      { secureTransport: 'starttls', allowHalfOpen: true },
    );
    await socket.opened;
  } catch (e) {
    logProxyError('连接代理失败', proxy, host, e);
    throw new Error(`代理连接失败: ${errDetail(e)}`);
  }

  // 阶段 2：CONNECT 握手
  let head: string;
  try {
    const connectWriter = socket.writable.getWriter();
    await connectWriter.write(new TextEncoder().encode(buildConnectRequest(host, proxy)));
    connectWriter.releaseLock();
    head = await readUntilCrlfCrlf(socket);
  } catch (e) {
    socket.close();
    logProxyError('CONNECT 失败', proxy, host, e);
    throw new Error(`代理 CONNECT 异常: ${errDetail(e)}`);
  }
  if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
    socket.close();
    logProxyError('CONNECT 非 200', proxy, host, new Error(head.split('\r\n')[0]));
    throw new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0]}`);
  }

  // 阶段 3：隧道内 TLS（先建明文读写，再 startTls 升级）
  // 必须传 expectedServerHostname：否则无 SNI，Google 等上游会在握手后被断开，导致响应解析失败
  let finalSocket: Socket;
  try {
    finalSocket = await socket.startTls({ expectedServerHostname: host });
  } catch (e) {
    socket.close();
    logProxyError('startTls 失败', proxy, host, e);
    throw new Error(`代理隧道 TLS 握手失败: ${errDetail(e)}`);
  }
  // 阶段 4：请求写入 + 响应读取（TLS 握手若实际失败，错误在此暴露）
  try {
    const writer = finalSocket.writable.getWriter();
    await writer.write(new TextEncoder().encode(buildRequest(method, host, path, headers, body)));
    writer.releaseLock();

    // 读响应头 + 按编码解码响应体（chunked / content-length / EOF）
    const r = new SocketByteReader(finalSocket);
    const sepIdx = await r.indexOf(CRLFCRLF);
    if (sepIdx < 0) throw new Error('代理响应缺少头部分隔');
    const headText = new TextDecoder().decode(r.take(sepIdx + 4));
    const status = Number.parseInt(headText.split(' ')[1] ?? '0', 10);
    if (!status) throw new Error('代理响应状态码解析失败');
    const headerObj = parseHeaders(headText);
    const isChunked = (headerObj['transfer-encoding'] ?? '').toLowerCase().includes('chunked');

    const bodyText = isChunked ? await readChunkedBody(r) : await readUntilEof(r);
    finalSocket.close();

    return { status, body: bodyText, headers: headerObj };
  } catch (e) {
    finalSocket.close();
    logProxyError('隧道读写失败', proxy, host, e);
    throw new Error(`代理隧道读写失败: ${errDetail(e)}`);
  }
}

/** 统一错误详情：名字 + 消息 + code */
function errDetail(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return e instanceof Error ? `${e.name}: ${e.message} (code=${code ?? 'n/a'})` : String(e);
}

/** 统一诊断日志：阶段 + 代理 + 目标 + 错误详情 */
function logProxyError(stage: string, proxy: ProxyConfig, host: string, e: unknown): void {
  console.error(`[proxy] [error] ${stage}`, JSON.stringify({ proxy: `${proxy.host}:${proxy.port}`, host, detail: errDetail(e) }));
}

/**
 * 直连 HTTPS 请求（不经代理）：socket 直连目标 + startTls + 手动 HTTP/1.1。
 * 相比 fetch，能携带完整浏览器头/UA，且走 HTTP/1.1 —— 对 Google 系风控更友好
 * （生产实测：fetch 抓 watch 页 429，socket 直连 200 + INNERTUBE_API_KEY/VISITOR_DATA 齐全）。
 */
export async function httpsRequestDirect(
  method: 'GET' | 'POST',
  host: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpOverSocketResult> {
  const socket = connect(
    { hostname: host, port: 443 },
    { secureTransport: 'starttls', allowHalfOpen: true },
  );
  await socket.opened;

  let finalSocket: Socket;
  try {
    finalSocket = await socket.startTls({ expectedServerHostname: host });
  } catch (e) {
    socket.close();
    throw new Error(`直连 TLS 握手失败: ${errDetail(e)}`);
  }

  try {
    const writer = finalSocket.writable.getWriter();
    await writer.write(new TextEncoder().encode(buildRequest(method, host, path, headers, body)));
    writer.releaseLock();

    const r = new SocketByteReader(finalSocket);
    const sepIdx = await r.indexOf(CRLFCRLF);
    if (sepIdx < 0) throw new Error('响应缺少头部分隔');
    const headText = new TextDecoder().decode(r.take(sepIdx + 4));
    const status = Number.parseInt(headText.split(' ')[1] ?? '0', 10);
    if (!status) throw new Error('响应状态码解析失败');
    const headerObj = parseHeaders(headText);
    const isChunked = (headerObj['transfer-encoding'] ?? '').toLowerCase().includes('chunked');

    const bodyText = isChunked ? await readChunkedBody(r) : await readUntilEof(r);
    finalSocket.close();

    return { status, body: bodyText, headers: headerObj };
  } catch (e) {
    finalSocket.close();
    throw new Error(`直连读写失败: ${errDetail(e)}`);
  }
}

/**
 * 读完整响应体：chunked 解码（去除 chunk 帧：<hex大小>\r\n数据\r\n...0\r\n\r\n）。
 * 必须正确解码，否则含 `108 ... 0 ` 的帧残留会让 JSON.parse 失败 → youtube_invalid_json。
 */
async function readChunkedBody(r: SocketByteReader): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const sizeLine = await r.readLine();
    if (sizeLine == null) break;
    const size = Number.parseInt(sizeLine.split(';')[0].trim(), 16); // 兼容 chunk 扩展
    if (!Number.isFinite(size) || size <= 0) break; // 0 为终止块
    while (r.available < size && !r.eof) await r.refill();
    if (r.available < size) {
      // EOF 提前截断：给出已收到的残留
      if (r.available > 0) out += decoder.decode(r.take(r.available), { stream: true });
      break;
    }
    out += decoder.decode(r.take(size), { stream: true });
    await r.readLine(); // 消费 chunk 尾部 CRLF
  }
  return out + decoder.decode();
}

/** 读直到 EOF（content-length 或连接关闭语义），按字节积累 */
async function readUntilEof(r: SocketByteReader): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    if (r.available === 0 && !r.eof) await r.refill();
    if (r.available === 0) return out + decoder.decode();
    out += decoder.decode(r.take(r.available), { stream: true });
  }
}

export interface ProxyStreamResult {
  status: number;
  headers: Record<string, string>;
  /** 响应体分块迭代器；自动处理 chunked / EOF 两种终止 */
  chunks: AsyncIterable<Uint8Array>;
}

/**
 * 流式代理隧道（HTTPS GET/POST）：建立 CONNECT 隧道后逐块读取响应体。
 * 用于 Gemini SSE 等长流——上游边产边读，客户端才能收到增量。
 */
export async function httpsStreamViaProxy(
  proxy: ProxyConfig,
  method: 'GET' | 'POST',
  host: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<ProxyStreamResult> {
  const socket = connect(
    { hostname: proxy.host, port: proxy.port },
    { secureTransport: 'starttls', allowHalfOpen: true },
  );
  await socket.opened;

  // 1. CONNECT 握手（同缓冲版）
  const connectWriter = socket.writable.getWriter();
  await connectWriter.write(new TextEncoder().encode(buildConnectRequest(host, proxy)));
  connectWriter.releaseLock();
  const head = await readUntilCrlfCrlf(socket);
  if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
    socket.close();
    throw new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0]}`);
  }

  // 2. 隧道内 TLS
  // 必须传 expectedServerHostname：否则无 SNI，Google 等上游会在握手后被断开，导致响应解析失败
  let finalSocket: Socket;
  try {
    finalSocket = await socket.startTls({ expectedServerHostname: host });
  } catch (e) {
    socket.close();
    const code = (e as { code?: unknown })?.code;
    const detail = e instanceof Error ? `${e.name}: ${e.message} (code=${code ?? 'n/a'})` : String(e);
    console.error(`[proxy] [error] startTls 失败`, JSON.stringify({ proxy: `${proxy.host}:${proxy.port}`, host, detail, connectHead: head.split('\r\n')[0] }));
    throw new Error(`代理隧道 TLS 握手失败: ${detail}`);
  }

  // 3. 发送 HTTP 请求
  const writer = finalSocket.writable.getWriter();
  await writer.write(new TextEncoder().encode(buildRequest(method, host, path, headers, body)));
  writer.releaseLock();

  // 4. 读响应头
  const r = new SocketByteReader(finalSocket);
  const sepIdx = await r.indexOf(CRLFCRLF);
  if (sepIdx < 0) throw new Error('代理响应缺少头部分隔');
  const headText = new TextDecoder().decode(r.take(sepIdx + 4));
  const status = Number.parseInt(headText.split(' ')[1] ?? '0', 10);
  if (!status) throw new Error('代理响应状态码解析失败');
  const headerObj = parseHeaders(headText);
  const isChunked = (headerObj['transfer-encoding'] ?? '').toLowerCase().includes('chunked');

  // 5. 响应体：chunked 解码 / EOF 截断
  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    if (isChunked) {
      for (;;) {
        const sizeLine = await r.readLine();
        if (sizeLine == null) break;
        const size = Number.parseInt(sizeLine.split(';')[0].trim(), 16); // 兼容 chunk 扩展
        if (!Number.isFinite(size) || size <= 0) break; // 0 为终止块
        while (r.available < size && !r.eof) await r.refill();
        if (r.available < size) {
          if (r.available > 0) yield r.take(r.available); // EOF 提前截断，给出发到的残留
          break;
        }
        yield r.take(size);
        await r.readLine(); // 消费 chunk 尾部 CRLF
      }
      return;
    }
    for (;;) {
      if (r.available === 0 && !r.eof) await r.refill();
      if (r.available === 0) return;
      yield r.take(r.available);
    }
  })();

  return { status, headers: headerObj, chunks };
}

const CRLFCRLF = new TextEncoder().encode('\r\n\r\n');

/** 响应头解析：首行跳过，键转小写 */
function parseHeaders(headText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of headText.split('\r\n').slice(1)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** 字节级缓冲读取器：跨 TCP 块缓冲，支持按分隔符 / 定长消费 */
class SocketByteReader {
  private buf = new Uint8Array(0);
  private ended = false;
  private reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(socket: Socket) {
    this.reader = socket.readable.getReader();
  }

  get available(): number {
    return this.buf.length;
  }

  get eof(): boolean {
    return this.ended && this.buf.length === 0;
  }

  async refill(): Promise<void> {
    if (this.ended) return;
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return;
    }
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf);
    next.set(value, this.buf.length);
    this.buf = next;
  }

  /** 等到缓冲中出现目标字节序列（或 EOF），返回其起始下标；找不到返回 -1 */
  async indexOf(seq: Uint8Array): Promise<number> {
    for (;;) {
      const m = this.buf.length;
      const n = seq.length;
      if (m >= n) {
        for (let i = 0; i <= m - n; i++) {
          let ok = true;
          for (let j = 0; j < n; j++) {
            if (this.buf[i + j] !== seq[j]) {
              ok = false;
              break;
            }
          }
          if (ok) return i;
        }
      }
      if (this.ended) return -1;
      await this.refill();
    }
  }

  take(n: number): Uint8Array {
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  /** 读取一行（含 `\n`，去换行符）；EOF 时返回 null */
  async readLine(): Promise<string | null> {
    const idx = await this.indexOf(LF);
    if (idx < 0) {
      if (this.buf.length === 0) return null;
      return new TextDecoder().decode(this.take(this.buf.length));
    }
    const line = this.take(idx + 1);
    return new TextDecoder().decode(line).replace(/\r?\n$/, '');
  }
}

const LF = new TextEncoder().encode('\n');

export function buildConnectRequest(host: string, proxy: ProxyConfig): string {
  const { user, pass } = proxy;
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
  if (!body) return `${head}\r\n`;
  // Content-Length 必须是 UTF-8 字节数，不能用 body.length（UTF-16 码元）。
  // 否则含中文的多字节 body 会被上游截断 → JSON 解析失败 / 连接被断开。
  const bytes = new TextEncoder().encode(body);
  return `${head}Content-Length: ${bytes.length}\r\n\r\n${body}`;
}

/** 读取直到 \r\n\r\n（CONNECT 握手响应） */
export async function readUntilCrlfCrlf(socket: Socket): Promise<string> {
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