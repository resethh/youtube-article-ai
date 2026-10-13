#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gemini 模型可用性测试脚本（判断 503 是不是模型/上游的问题）

背景：/api/article 报错
    生成失败：Gemini 流式请求失败 503: {"error":{"code":503,"message":"This model is
    currently experiencing high demand..."}}
这类 503 绝大多数是 Google 上游瞬时过载，不是本项目代码问题，几分钟后会自愈。

本脚本绕过项目，直接调 Google Gemini API，回答三个问题：
  1. 当前配置的模型能不能通？（HTTP 200 且有回复）
  2. 503 是否只出现在某几个模型上？—— 用 --model 批量对比
  3. 走不走代理结果是否一致？—— 默认读 .dev.vars 的代理配置，可用 --no-proxy 跳过

用法（在项目根目录运行）：
  python test/api-model-test.py                                  # 测 .dev.vars 里的模型
  python test/api-model-test.py --model gemini-3.8-flash         # 指定模型
  python test/api-model-test.py --model gemini-3.8-flash,gemini-2.0-flash-s  # 逗号分隔测多个
  python test/api-model-test.py --stream            # 用 alt=sse 流式接口（复刻 app 主文章路径）
  python test/api-model-test.py --no-proxy          # 不走本地代理，直连
  python test/api-model-test.py --retries 3 --wait 1500

退出码: 0 = 至少一个模型成功; 1 = 全部失败; 2 = 参数/环境错误

仅用标准库，无需 pip 安装任何依赖。
"""

from __future__ import print_function

import json
import os
import re
import sys
import time

try:
    from http.client import HTTPSConnection  # Python 3
except ImportError:  # pragma: no cover - Python 2
    from httplib import HTTPSConnection  # type: ignore


# ---------------------------------------------------------------- 工具

def resolve_root():
    return os.path.dirname(os.path.abspath(__file__)).replace("\\", "/")


def load_dev_vars():
    """解析 .dev.vars（# 注释、空行跳过，KEY=VALUE），未配置则返回空 dict。兼容 py2/py3。"""
    vars_ = {}
    path = os.path.join(resolve_root(), "..", ".dev.vars")
    try:
        with open(path, "rb") as f:  # py2 的 open 无 encoding 参数，统一按字节读
            text = f.read().decode("utf-8", "replace")
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            vars_[k.strip()] = v.strip()
    except (IOError, OSError):
        vars_["__absent__"] = True
    return vars_


def as_text(b):
    """bytes/str 统一转成 str，解码失败的字节用 � 替换。"""
    if isinstance(b, str):
        return b
    if sys.version_info[0] < 3 and isinstance(b, bytes):
        return b.decode("utf-8", "replace")
    return b.decode("utf-8", "replace")


def safe(s, n=160):
    """把输出裁剪成单行可读文本，避免打印整段判断/正文刷屏。"""
    s = re.sub(r"\s+", " ", as_text(s)).strip()
    return s[:n] + "..." if len(s) > n else s


def out(msg, color=None):
    """带可选 ANSI 颜色的打印（Windows 终端兼容：非 TTY 去色）。"""
    line = msg if not color else "\033[%sm%s\033[0m" % (color, msg)
    try:
        print(line)
    except UnicodeEncodeError:
        print(line.encode("utf-8", "replace").decode("utf-8", "replace"))


def green(s): return "\033[32m%s\033[0m" % s
def red(s):   return "\033[31m%s\033[0m" % s
def yellow(s): return "\033[33m%s\033[0m" % s
def dim(s):   return "\033[2m%s\033[0m" % s


def build_proxy(vars_):
    """从 .dev.vars 推导代理配置；未配置返回 None。"""
    host = vars_.get("PROXY_HOST", "").strip()
    port = vars_.get("PROXY_PORT", "").strip()
    if not host or not port:
        return None
    return {"host": host, "port": int(port),
            "user": vars_.get("PROXY_USER", "").strip() or None,
            "pass": vars_.get("PROXY_PASS", "").strip() or None}


# ---------------------------------------------------------------- Gemini 调用

def sse_frame_text(frame):
    """解析单个 SSE frame：取 data: 行的 JSON，提取可视文本 parts。"""
    try:
        data = json.loads(frame.split("data:", 1)[1].strip())
    except Exception:
        return ""
    parts = ((data.get("candidates", [{}])[0] or {}).get("content", {}) or {}).get("parts", []) or []
    out_ = []
    for part in parts:
        if isinstance(part, dict) and not part.get("thought") and part.get("text"):
            out_.append(part["text"])
    return "".join(out_)


def call_gemini(api_key, model, prompt, stream, proxy, timeout):
    """
    直连 Gemini（可选走代理隧道）。返回 (status, body, truncated)。
    body = 非流式/流式拼合后的响应文本；truncated 表示流被中途截断。
    """
    host = "generativelanguage.googleapis.com"
    port = 443

    # 非流式 :generateContent 返回 JSON；流式 :streamGenerateContent 返回 SSE
    endpoint = "streamGenerateContent" if stream else "generateContent"
    path = "/v1beta/models/%s:%s?key=%s" % (model, endpoint, api_key)
    if stream:
        path += "&alt=sse"

    payload = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        # maxOutputTokens 太小会被 thinking 消耗光 → 回复为空，别用 64
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
    })

    connect_headers = {"Content-Type": "application/json"}
    conn = HTTPSConnection(host, port, timeout=timeout)
    try:
        if proxy:
            connect_headers.update({"Proxy-Connection": "keep-alive"})
            # set_tunnel 会先对代理发 CONNECT host:443 再建 TLS
            conn.set_tunnel(proxy["host"], proxy["port"])
        conn.request("POST", path, body=payload.encode("utf-8"), headers=connect_headers)
        resp = conn.getresponse()
        status = resp.status

        # 流式：逐块读，边读边拆 SSE；非流式：一次性读完
        parts = []
        buf = ""
        truncated = False
        try:
            if stream:
                while True:
                    chunk = resp.read(4096)
                    if not chunk:
                        break
                    buf += as_text(chunk)
                    while "\n\n" in buf:
                        frame, buf = buf.split("\n\n", 1)
                        if frame.startswith("data:"):
                            t = sse_frame_text(frame)
                            if t:
                                parts.append(t)
                # 收尾：结尾没有双换行的残留 frame
                if buf.strip():
                    if buf.strip().startswith("data:"):
                        t = sse_frame_text(buf)
                        if t:
                            parts.append(t)
            else:
                body = resp.read()
                parts.append(as_text(body))
        except Exception:
            truncated = True  # 连接中途断开：拿到多少算多少
        return status, "".join(parts), truncated
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ---------------------------------------------------------------- 探测逻辑

def probe_model(api_key, model, stream, proxy, retries, wait_ms, timeout):
    """对单个模型做指数退避重试。返回 (ok, detail)。detail 记录最后一次失败原因。"""
    prompt = "请用一句话回复：这是一次连通性测试。"
    detail = "未尝试"
    for i in range(1, retries + 2):
        t0 = time.time()
        try:
            status, body, truncated = call_gemini(api_key, model, prompt, stream, proxy, timeout)
            ms = int((time.time() - t0) * 1000)
            if status == 200:
                if not body.strip():
                    detail = "HTTP 200 但回复为空（可能是 thinking 未产出正式文本）"
                    out("    %s HTTP 200 但空回复" % dim(i), None)
                elif truncated:
                    detail = "HTTP 200 但流被中途截断"
                    out("    %s HTTP 200 但流中途截断 (%dms)" % (dim(i), ms), None)
                else:
                    out("    ✅ 成功  HTTP 200 (%dms)  回复: %s" % (ms, safe(body, 60)), None)
                    return True, "HTTP 200"
                if i <= retries:
                    wait = min(wait_ms * 2 ** (i - 1), 30000)
                    out("       等待 %dms 重试..." % wait, None)
                    time.sleep(wait / 1000.0)
                continue
            # 非 200：打印错误摘要
            detail = "HTTP %d: %s" % (status, safe(body, 160))
            out("    ❌ 失败  HTTP %d (%dms)  %s" % (status, ms, safe(body, 160)), None)
        except Exception as e:
            detail = "异常: %s" % as_text(str(e))
            out("    ❌ 异常  (%dms)  %s" % (int((time.time() - t0) * 1000), detail), None)

        if i <= retries:
            wait = min(wait_ms * 2 ** (i - 1), 30000)
            out("       等待 %dms 重试..." % wait, None)
            time.sleep(wait / 1000.0)
    return False, detail


def report_summary(results):
    """打印汇总，返回退出码。results: [(model, ok, detail)]"""
    out("")
    out("== 汇总 ==")
    all_ok = True
    for model, ok, detail in results:
        if ok:
            out("  ✅ %-24s 可用" % model, None)
        else:
            all_ok = False
            out("  ❌ %-24s 失败  (%s)" % (model, safe(detail, 120)), None)
    if all_ok:
        out(green("全部模型可用 → 503 是瞬时过载，稍后重试即可。"))
    else:
        out(yellow("有模型失败 → 若失败的是复无数个、且 --retries 重试仍不行，"
                   "多半是该模型当前过载（几天后自愈），可临时换模型试试。"))
    return 0 if all_ok else 1


# ---------------------------------------------------------------- CLI

USAGE = """用法:
  python test/api-model-test.py [--model gemini-3.8-flash,gemini-2.0-flash-s]
                                [--retries 3] [--wait 1500] [--stream] [--no-proxy] [--timeout 60]

  --model M        模型，逗号分隔可测多个（默认取 .dev.vars 的 GEMINI_MODEL，缺省 gemini-3.8-flash）
  --retries N      503 重试次数（默认 3），指数退避
  --wait MS        首次重试等待毫秒（默认 1500）
  --stream         用 alt=sse 流式接口（复刻 app 主文章路径；默认用非流式更快的基线探测）
  --no-proxy       不走 .dev.vars 里的代理，直连
  --timeout SEC    单次请求超时秒数（默认 60）
退出码: 0 = 至少一个模型成功; 1 = 全部失败; 2 = 参数/环境错误"""


def main(argv):
    args = argv[1:]
    def flag(name):
        return name in args
    def value(name, default):
        for i, a in enumerate(args):
            if a == name and i + 1 < len(args):
                return args[i + 1]
        return default

    if not args or flag("--help") or flag("-h"):
        print(USAGE)
        return 2

    vars_ = load_dev_vars()
    api_key = vars_.get("GEMINI_API_KEY")
    if not api_key:
        print(red("ERROR: 未找到 GEMINI_API_KEY。请在项目根目录的 .dev.vars 配置，或用 --env 指定 API key。"))
        return 2

    default_model = vars_.get("GEMINI_MODEL") or "gemini-3.8-flash"
    models = [m.strip() for m in value("--model", default_model).split(",") if m.strip()]
    retries = int(value("--retries", "3"))
    wait_ms = int(value("--wait", "1500"))
    timeout = int(value("--timeout", "60"))
    stream = flag("--stream")
    proxy = None if flag("--no-proxy") else build_proxy(vars_)

    out("模型: %s" % ", ".join(models), None)
    out("代理: %s  模式: %s  重试: %d" % (
        "%s:%s" % (proxy["host"], proxy["port"]) if proxy else "无（直连）",
        "流式(SSE)" if stream else "非流式",
        retries,
    ), None)
    out(dim("提示: HTTP 503 + high demand = Google 上游瞬时过载，通常几分钟后自愈。若重试仍失败才考虑换模型。"))
    out("")

    results = []
    for model in models:
        out("== 测试模型 %s ==" % model, None)
        ok, detail = probe_model(api_key, model, stream, proxy, retries, wait_ms, timeout)
        results.append((model, ok, detail))
    return report_summary(results)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        print("\n已中断")
        sys.exit(130)