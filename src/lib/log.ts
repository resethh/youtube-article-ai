/**
 * 轻量日志：统一输出带时间戳和模块标签的日志，方便在 wrangler dev / 线上 logs 里排查。
 * 始终用 console.error 输出到 stderr，避免污染 SSE 响应体（若写 stdout 会混进流式响应）。
 */
export function log(module: string, level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${module}] [${level}] ${msg}`;
  if (extra !== undefined) {
    // 只打印可序列化的摘要；遇循环引用时降级为 String()
    try {
      console.error(line, JSON.stringify(extra));
    } catch {
      console.error(line, String(extra));
    }
  } else {
    console.error(line);
  }
}

export function logInfo(module: string, msg: string, extra?: unknown): void {
  log(module, 'info', msg, extra);
}

export function logWarn(module: string, msg: string, extra?: unknown): void {
  log(module, 'warn', msg, extra);
}

export function logError(module: string, msg: string, extra?: unknown): void {
  log(module, 'error', msg, extra);
}
