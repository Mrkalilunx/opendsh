#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""opencode-api.py — 单次调用 opencode 免费模型 / 模型列表 / OpenAI 兼容代理

用法：
    python3 opencode-api.py "你的问题"                   # 默认 deepseek-v4.1-flash-free
    python3 opencode-api.py -m glm-5.3-flash-free "问题"  # 换模型
    echo 问题 | python3 opencode-api.py                  # 从 stdin 读
    python3 opencode-api.py -l                           # 列出模型
    python3 opencode-api.py -l --free                    # 只列免费模型
    python3 opencode-api.py serve                        # 起 OpenAI 兼容代理（127.0.0.1:8787）
    python3 opencode-api.py serve --port 9000 --api-key sk-local
    python3 opencode-api.py serve --proxies-file proxies.txt

代理端点（OpenAI 兼容）：
    GET  /v1/models                模型列表
    GET  /v1/models/{model}        单个模型
    POST /v1/chat/completions      chat completions（stream / 非 stream）
    POST /v1/completions           旧版 text completions
    GET  /health                   健康检查（本脚本扩展）

──────────────────────────── 注意事项（改代码前先看） ────────────────────────────

1. 门禁在 TLS 层，四个条件必须同时满足，缺一即 429：
     ① ClientHello 指纹（JA3）—— 见下方 JA3 常量；
     ② 请求头 user-agent: opencode/2.0.22/cli + 4 个 session 头；
     ③ session id 结构合法 —— 见 new_session_id()；
     ④ body 的 system prompt 必须是 OpenCode 原版、tools 必须非空。
   普通 curl / urllib 一律 429，curl_cffi 只有配上 ja3= 才通得过。

2. system prompt 和 tools 都来自 ocask-body.json（OpenCode 原版模板），
   客户端自己的 system 消息只能排在它后面（实测有效），不能替换。

3. 模板和 opencode 2.0.22 绑定。升级 OpenCode 后如果全 429，
   说明服务端校验的 system prompt 变了，需要重新抓一份 body。

4. 额度按 (IP, session_id) 两个维度各自计数，不是单一维度：
     - 换 IP 但复用旧 session：旧的 session 已经到限额，照样不可用；
     - 已耗尽的 session 还会把新 IP 也一起标记成限额（污染）；
     - 所以要继续用必须**同时**换 IP 和 session id，只换一边无效。
   本脚本启动时先生成一批 session id（默认 20 个）循环使用，
   平时不换池子；只有额度 429 时才整池作废、重新生成一批。
   出口 IP 默认只有本机一个，所以单机仍受 IP 限额约束。
   配好代理池（OCASK_PROXIES 或 proxies.txt）后会自动 IP + session 一起轮换。
   每日额度 UTC 00:00 重置（北京时间 08:00），超了返回 429 FreeUsageLimitError。

5. 上游有短时限流：连续快速请求会 429，等几秒就好。
   代理不原样透传上游的 Retry-After，429 一律改写成 10 秒
   （上游经常给到 814 秒这种，客户端会干等十几分钟）。

6. 参数映射：OpenAI 的 max_tokens 上游不认，只有 max_completion_tokens 生效，
   所以 translate_request() 里做了转换。n 只支持 1，传别的直接 400。

7. 客户端传的 tools 会追加到模板 tools 后面（模板的 12 个不能删，门禁要求非空）；
   同名工具跳过，避免重名。tool_choice 原样透传。

8. 响应里可能带 reasoning_content（DeepSeek 风格的思维链），这是扩展字段，
   标准 OpenAI 客户端会忽略它。

9. 代理本身无状态：不存会话，多轮由客户端把历史塞进 messages。
   CLI 模式（不带 --serve）永远是单轮单次请求。

10. 不支持 /v1/embeddings、/v1/images 等端点，返回 404 + OpenAI 错误体。

11. 默认不校验 Authorization，随便填 sk-xxx 都行；
   传了 --api-key 就要求 Bearer 完全一致，否则 401。

──────────────────────────── 额度与出口轮换 ────────────────────────────

服务端按 (IP, session_id) 两个维度分别计数，缺一不可：

    A IP + a session  → 耗尽
    换成 B IP + a session → 仍然 429（a session 自己到限额了）
    B IP 还会被 a session 一起标记成限额（污染），
    之后再拿 B IP + b session 也不行

结论：想继续用必须**同时**更换 IP 和 session。脚本的做法：

- session id 用预生成的池子轮转（默认 20 个，OCASK_SESSIONS 可改），
  平时一直轮转不换池；只有额度 429 时才整池作废、重新生成一批，
  因为每请求都新生成 session 会被上游判异常；
- 出口 IP 通过代理池轮换，只有配了池子才真正摆脱单 IP 限额。

用法（三种来源可叠加，按 命令行 → 环境变量 → 文件 收集，去重保序）：

    python3 opencode-api.py --serve --proxy socks5://127.0.0.1:1080
    python3 opencode-api.py --serve --proxy http://1.2.3.4:8080 --proxy http://5.6.7.8:8080
    OCASK_PROXIES="http://1.2.3.4:8080,socks5://127.0.0.1:1080" python3 opencode-api.py "问题"
    python3 opencode-api.py --serve --proxies-file proxies.txt

proxies.txt 每行一个，空行和 # 注释会被跳过，不写协议前缀按 http 处理。

遇到额度 429（error.type == FreeUsageLimitError）时自动换下一组「新 IP + 新 session」，
有几个代理就最多试几个（可用 OCASK_ATTEMPTS 限制次数）。
门禁类 429 不重试——那不是额度问题，换 IP 也没用，浪费出口。

注意：免费额度仍按天重置（UTC 00:00 / 北京 08:00）。
代理池只解决「单 IP 额度用尽」，不能凭空造额度：
池子里每个 IP 的额度依然是独立的、有限的。

用手机流量时不必配代理池，直接换 IP 更简单：

    1. 打开飞行模式 5~10 秒再关掉（或直接关掉「移动数据」再打开）；
    2. 运营商一般会重新分配一个出口 IP，等信号恢复；
    3. 脚本不用重启 —— 下一次请求本来就是新 IP + 池子里的下一个 session。

Wi-Fi 下要换 IP 通常得重连路由器或换网络，不如流量方便。

坑：部分运营商是 CGNAT，很多人共享同一个出口 IP，开关数据也可能拿到同一个 IP，
这时只能靠代理池。是否真换了 IP，请求前先确认一下（本机 v4/v6 都通）：

    curl ifconfig.me        # 默认走 IPv6，例如 2001:db8:2a3f:1c05:...
    curl ipinfo.io/ip       # 返回 IPv4，例如 198.51.100.7
    curl -4 ifconfig.me     # 强制 IPv4
    curl -6 ifconfig.me     # 强制 IPv6

要拿同一条命令前后对比才有意义：开关数据后 v4、v6 都应该变。
注意 api.ipify.org 在本机连不上（不是没有 v4 出口），别拿它当判断依据。

没有代理池时，额度 429 的错误 message 会直接带上一句
「请关闭再开启移动数据（或开关飞行模式）换 IP 后重试」，
CLI 和 OpenAI 客户端都能看到，不用回来翻文档。

──────────────────────────── 已知边界（绕不过去，别硬试） ────────────────────────────

- n 只支持 1：上游永远只回一个 choice，多返回就是假的，所以 n != 1 直接 400。
- 没有 /v1/embeddings、/v1/images/generations、/v1/audio/*，统一 404 unknown_url。
- system prompt 和模板里那 12 个 tools 不能替换（门禁条件④），客户端的 tools 只能往后追加。
- 客户端传的模型名不在网关列表里时回落到默认模型，不报 404；响应里的 model 是实际用的那个。
- reasoning_content 是 DeepSeek 风格扩展字段，标准 OpenAI 客户端会忽略它。
- 无重试、无会话存储、无限流：一次请求只打一次上游，失败原样返回给客户端。
  例外：额度类 429 会按代理池换出口重试，见上面「额度与出口轮换」。
- 上游短时限流（429）透传错误体，但 Retry-After 固定写 10 秒，不让客户端干等；
  免费额度超了是 FreeUsageLimitError。
- 流式响应用 Connection: close 收尾，不用 chunked；HTTP/1.1 + SSE，客户端读到 EOF 结束。
- 多模态 content 数组原样透传，但只验证过纯文本，VL 模型吃不吃图片没验证。
- 本机装不了官方 openai SDK（jiter 是 Rust 扩展，没有 android-arm64 轮子），
  兼容性是拿 curl 逐项对着 OpenAI schema 验的，不是 SDK 验的。

──────────────────────────── 配合 opencode 使用 ────────────────────────────

在 ~/.config/opencode/opencode.json 的 providers 里加一段（本机已经加好，id 是 ocfree）：

    "ocfree": {
      "name": "OpenCode Free (Local Proxy)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "sk-any" },
      "models": { "deepseek-v4.1-flash-free": { "name": "DeepSeek V4.1 Flash (free)" } }
    }

选模型时用 ocfree/deepseek-v4.1-flash-free。注意代理必须先起来：

    python3 opencode-api.py --serve

另外 opencode.json 顶层已经写了 "model": "ocfree/deepseek-v4.1-flash-free"，
所以新会话默认就走这里。内置 opencode 供应商是官方账号级免费额度，
用光就是 429（FreeUsageLimitError，提示 subscribe to OpenCode Go），换 IP 也没用；
ocfree 是按 (IP, session) 计数，换 IP 能续。改完配置要重启 opencode 才生效
（Android 上 watcher backend not supported，配置不会热加载）。

opencode 发过来的 system prompt 会排在模板 system 后面（实测能生效），
它的 tools 也会追加到模板 tools 后面，同名跳过。

启动器（本机已装）：~/0/bin/opencode，~/.zshrc 里已经把 ~/0/bin 前置到 PATH。
敲 opencode 时它先探 127.0.0.1:8787/health：

    - 没起来 → nohup python3 ~/0/opencode-api.py serve >>~/0/proxy.log 2>&1 &!
    - 有 ~/0/proxies.txt → 自动带 --proxies-file
    - 已经在跑 → 跳过，不会起第二个

然后 exec 真正的 /data/data/com.termux/files/usr/bin/opencode。
端口用 OCASK_PORT 覆盖，默认 8787。
注意：只有从 shell 启动才会走这个包装；代理中途挂了也不会自己重启，
下次启动 opencode 时才会重新拉起。
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from curl_cffi import requests

# ---------------------------------------------------------------- 常量

HERE = Path(__file__).resolve().parent
# 请求模板：OpenCode 原版 system prompt + 12 个 tools，门禁必需，别删
TEMPLATE = Path(os.environ.get("OCASK_TEMPLATE", HERE / "ocask-body.json"))

ENDPOINT = "https://opencode.ai/inference/openai/v1/chat/completions"
MODELS_ENDPOINT = "https://opencode.ai/inference/v1/models"
USER_AGENT = "opencode/2.0.22/cli"
DEFAULT_MODEL = "deepseek-v4.1-flash-free"
# OpenAI 响应里的 system_fingerprint，随便编一个稳定值即可
SYSTEM_FINGERPRINT = "fp_opencode"
# 429 的 Retry-After 上游经常给到十几分钟（814 秒这种），opencode 会老老实实等。
# 统一压成 10 秒：换 IP / 换出口之后下一次重试就能接上，不用干等。
# 只在代理这一层改，客户端拿到的就是这个值。
RETRY_AFTER_429 = "10"
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

# 客户端可以原样透传给上游的 OpenAI 参数（都实测 200）
PASSTHROUGH_PARAMS = (
    "temperature",
    "top_p",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "user",
    "response_format",
    "logit_bias",
    "logprobs",
    "top_logprobs",
    "parallel_tool_calls",
    "reasoning_effort",
    "service_tier",
    "metadata",
    "store",
)

# Bun 的 ClientHello 指纹，改写成 curl_cffi 能用的 TLS 1.2 形式：
#   密码套件 = Bun 那 17 个里的 TLS1.2 子集，保持原顺序（不能带 4865-4867，那是 TLS1.3 的）
#   扩展顺序 = SNI(0) 打头，接 Bun 的 23-65281-10-11-35-16-5-13-18-51-45-43
#   曲线     = x25519(29) / secp256r1(23) / secp384r1(24)
# 坑：必须写十进制（写 hex 会报 Cipher 0x515 is not found）；
#     扩展顺序必须以 0 开头（否则 Invalid TLS extension order）。
JA3 = (
    "771,"
    "49195-49199-49196-49200-52393-52392-49161-49171-49162-49172-156-157-47-53,"
    "0-23-65281-10-11-35-16-5-13-18-51-45-43,"
    "29-23-24,0"
)

# session id 生成用的同毫秒自增序号（见 new_session_id）
_last_ms = 0
_seq = 0

# 预生成的 session 池大小：启动后第一次用到时一次性生成，之后循环使用。
# 早先是每个请求都新生成一个，实测连续换 session 也会被上游判成异常，
# 所以改成固定池子轮转（OCASK_SESSIONS 可改数量）。
SESSION_POOL_SIZE = max(1, int(os.environ.get("OCASK_SESSIONS", "20") or 20))


# ---------------------------------------------------------------- 异常


class APIError(RuntimeError):
    """上游请求失败（非 200）。"""

    def __init__(
        self,
        status: int,
        body: str,
        retry_after: str | None = None,
        hint: str | None = None,
    ) -> None:
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body
        self.retry_after = retry_after
        # 给调用方的可操作提示（例如额度用尽时告诉用户去开关移动数据）
        self.hint = hint


class BadRequest(ValueError):
    """客户端请求参数不合法，对应 OpenAI 的 400 invalid_request_error。"""

    def __init__(self, message: str, param: str | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.param = param
        self.code = code


# ---------------------------------------------------------------- 基础工具


def new_session_id() -> str:
    """复刻 app 的 Identifier.ascending("session")。

    n = Date.now() * 4096 + 同毫秒内自增序号，按位取反后取低 48 位转 12 位 hex，
    再接 14 位随机 base62。服务端只校验前 12 位 hex，后 14 位随意。
    """
    global _last_ms, _seq
    ms = int(time.time() * 1000)
    if ms != _last_ms:
        _last_ms = ms
        _seq = 0
    _seq += 1
    o = (~(ms * 4096 + _seq)) & ((1 << 48) - 1)
    return "ses_" + format(o, "012x") + "".join(secrets.choice(ALPHABET) for _ in range(14))


# 池子和游标：懒加载，第一次取的时候才生成，避免 import 阶段就耗随机数
_SESSION_POOL: list[str] = []
_SESSION_LOCK = threading.Lock()
_session_idx = 0


def next_session_id() -> str:
    """从预生成的池子里按顺序取一个，取完从头循环。

    池子在第一次调用时生成 SESSION_POOL_SIZE 个（默认 20）。
    平时就一直轮转，不换池子；只有上游返回额度 429 时
    才由 reset_session_pool() 整池作废、重新生成一批。
    """
    global _session_idx
    with _SESSION_LOCK:
        if not _SESSION_POOL:
            _SESSION_POOL.extend(new_session_id() for _ in range(SESSION_POOL_SIZE))
        sid = _SESSION_POOL[_session_idx % len(_SESSION_POOL)]
        _session_idx += 1
        return sid


def reset_session_pool() -> None:
    """额度用尽时把整池 session 作废，重新生成一批新的。

    调用点只有一处：open_stream() 收到 FreeUsageLimitError 时。
    平时（200）不动池子，避免每请求都换 session 被上游判异常。
    """
    global _session_idx
    with _SESSION_LOCK:
        _SESSION_POOL[:] = [new_session_id() for _ in range(SESSION_POOL_SIZE)]
        _session_idx = 0
    sys.stderr.write(
        f"[proxy] 额度 429：重新生成 {SESSION_POOL_SIZE} 个 session\n"
    )


def _load_template() -> dict:
    """读模板（每次读，方便改完文件不重启）。"""
    return json.loads(TEMPLATE.read_text(encoding="utf-8"))


class Router:
    """分配「出口 IP + session id」组合。

    服务端按 (IP, session) 两个维度分别计额度：
      - 只换 IP、复用旧 session → 旧 session 已限额，照样 429；
      - 已耗尽的 session 还会把新 IP 也标记成限额（污染）；
      - 只有同时换 IP 和 session 才有效。
    session 从预生成的池子里轮转（next_session_id()），
    有代理池时出口 IP 也按轮转换，两者一起变。
    用手机流量的话也可以不配代理池：开关一次飞行模式/移动数据就能换 IP。
    """

    def __init__(self, proxies: list[str] | None = None) -> None:
        # None 表示直连（没有代理池时只有一条路）
        self.proxies: list[str | None] = list(proxies) if proxies else [None]
        self._idx = 0
        self._lock = threading.Lock()

    def next(self) -> tuple[str | None, str]:
        with self._lock:
            proxy = self.proxies[self._idx % len(self.proxies)]
            self._idx += 1
        return proxy, next_session_id()

    def __len__(self) -> int:
        return len(self.proxies)


# 全局路由表，serve() 或 CLI 启动时按需替换
ROUTER = Router()


def parse_proxies(raw: list[str] | None, path: str | None) -> list[str]:
    """收集代理地址：命令行 -> 环境变量 -> 文件，去重保序。

    每行一个，支持 http:// / https:// / socks5:// 前缀，不写前缀按 http 处理。
    """
    items: list[str] = []
    if raw:
        items.extend(raw)
    env = os.environ.get("OCASK_PROXIES") or ""
    if env:
        items.extend(env.replace(",", " ").split())
    if path:
        p = Path(path)
        if not p.exists():
            raise SystemExit(f"代理文件不存在: {p}")
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                items.append(line)

    out: list[str] = []
    for item in items:
        item = item.strip()
        if not item:
            continue
        if "://" not in item:
            item = "http://" + item
        if item not in out:
            out.append(item)
    return out


def _attempts() -> int:
    """一次请求最多打几个出口：有几个代理就试几个，每次换出口 + 池里下一个 session。"""
    n = max(1, len(ROUTER))
    limit = int(os.environ.get("OCASK_ATTEMPTS", "0") or 0)
    return min(n, limit) if limit > 0 else n


def _quota_hint() -> str:
    """额度耗尽时给用户的可操作提示。没有代理池就只能靠开关数据换 IP。"""
    if len(ROUTER) <= 1:
        return (
            "免费额度已用尽，且没有配置代理池：请关闭再开启移动数据"
            "（或开关一次飞行模式）换出口 IP 后重试，session 池已经自动换了一批。"
        )
    return f"代理池里 {len(ROUTER)} 个出口都到限额了：换一批新代理，或者关闭再开启移动数据换 IP 后重试。"


def build_body(messages: list[dict], model: str, params: dict | None = None) -> dict:
    """拼上游请求体 = 模板 + OpenCode 原版 system prompt + 调用方 messages。

    模板里的 system prompt 和 tools 是门禁硬要求，不能动；
    调用方的 system/user/assistant/tool 消息原样排在后面。
    上游永远走流式（stream=true），非流式由代理自己聚合，这样代码只有一条路径。
    """
    tpl = _load_template()
    system = next(m["content"] for m in tpl["messages"] if m["role"] == "system")
    body = {
        **tpl,
        "model": model,
        "messages": [{"role": "system", "content": system}, *messages],
    }
    if params:
        body.update(params)
    # 强制流式 + 带上 usage：代理聚合、转发都要用到
    body["stream"] = True
    body["stream_options"] = {"include_usage": True}
    return body


def open_stream(body: dict):
    """发一次上游请求，返回 curl_cffi 的 Response（stream=True）。

    额度是 (IP, session) 双维度计数：
      - 平时 session 从池子里轮转，不换池子；
      - 只有上游返回 FreeUsageLimitError 时，才整池作废、重新生成一批 session，
        再换下一个出口重试；有几个代理最多试几个。
    """
    attempts = _attempts()
    last: APIError | None = None
    pool_reset = False

    for _ in range(attempts):
        proxy, sid = ROUTER.next()
        headers = {
            "user-agent": USER_AGENT,
            "content-type": "application/json",
            # 这 4 个 session 头是门禁条件②的一部分，值必须一样
            "x-opencode-session": sid,
            "x-opencode-session-id": sid,
            "x-session-affinity": sid,
            "x-session-id": sid,
        }
        try:
            res = requests.post(
                ENDPOINT,
                headers=headers,
                data=json.dumps(body, ensure_ascii=False),
                ja3=JA3,
                timeout=300,
                stream=True,
                proxy=proxy,
            )
        except Exception as exc:
            last = APIError(0, f"请求失败: {exc}")
            continue

        if res.status_code == 200:
            return res

        err = APIError(res.status_code, res.text, res.headers.get("retry-after"))
        last = err
        # 只有额度/限流类的 429 值得换出口；门禁 429 换 IP 也没用，直接抛
        if res.status_code != 429 or "FreeUsageLimitError" not in res.text:
            raise err

        # 额度用尽：这一池 session 都别用了，整池换新
        if not pool_reset:
            reset_session_pool()
            pool_reset = True

    if last is not None and "FreeUsageLimitError" in last.body:
        # 所有出口都试过了还是额度不足 —— 告诉用户下一步该干什么
        last.hint = _quota_hint()
    raise last or APIError(0, "没有可用的出口")


def iter_chunks(res):
    """把上游 SSE 解成一个个 JSON 对象（跳过空行和 [DONE]）。"""
    for line in res.iter_lines():
        if not line.startswith(b"data: "):
            continue
        payload = line[6:]
        if payload == b"[DONE]":
            continue
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            continue


def norm_usage(usage: dict | None) -> dict:
    """补齐 OpenAI 的 usage 细节字段，缺了就填 0。"""
    if not usage:
        return {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "prompt_tokens_details": {"cached_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 0},
        }
    return {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "prompt_tokens_details": {
            "cached_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
        },
        "completion_tokens_details": {
            "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
        },
    }


def _new_call_id() -> str:
    return "call_" + secrets.token_hex(12)


# ---------------------------------------------------------------- CLI：单次请求


def ask(prompt: str, model: str = DEFAULT_MODEL) -> str:
    """单次请求：边收边打到 stdout，返回完整文本。"""
    res = open_stream(build_body([{"role": "user", "content": prompt}], model))
    out: list[str] = []
    for data in iter_chunks(res):
        for ch in data.get("choices") or []:
            text = (ch.get("delta") or {}).get("content")
            if text:
                out.append(text)
                sys.stdout.write(text)
                sys.stdout.flush()
    return "".join(out)


# ---------------------------------------------------------------- 模型列表


def list_models() -> list[dict]:
    """列出网关提供的模型（这个端点不需要额度）。"""
    try:
        res = requests.get(MODELS_ENDPOINT, headers={"user-agent": USER_AGENT}, timeout=60)
    except Exception as exc:
        raise APIError(0, f"请求失败: {exc}") from exc
    if res.status_code != 200:
        raise APIError(res.status_code, res.text)
    doc = res.json()
    return doc.get("data", doc) if isinstance(doc, dict) else doc


def free_model_ids() -> set[str] | None:
    """从本地 models.dev 目录读 cost.input == 0 的模型 id；读不到返回 None。"""
    db = Path(os.environ.get("OPENCODE_DB", Path.home() / ".local/share/opencode/opencode.db"))
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        row = con.execute("select value from kv where key='models-dev:catalog'").fetchone()
        con.close()
        if not row:
            return None
        catalog = json.loads(json.loads(row[0])["body"])
        models = (catalog.get("opencode") or {}).get("models") or {}
        return {mid for mid, m in models.items() if (m.get("cost") or {}).get("input", 1) == 0}
    except Exception:
        return None


def print_models(only_free: bool) -> int:
    try:
        models = list_models()
    except APIError as exc:
        print(exc, file=sys.stderr)
        return 1

    known = free_model_ids()

    def is_free(mid: str) -> bool:
        return mid.endswith("-free") if known is None else (mid in known or mid.endswith("-free"))

    if only_free:
        models = [m for m in models if is_free(m["id"])]

    width = max((len(m["id"]) for m in models), default=4)
    print(f"{'ID':<{width}}  {'OWNER':<10}  FREE")
    for m in models:
        print(f"{m['id']:<{width}}  {m.get('owned_by', ''):<10}  {'yes' if is_free(m['id']) else ''}")
    print(f"\n共 {len(models)} 个模型，其中免费 {sum(1 for m in models if is_free(m['id']))} 个")
    return 0


# ---------------------------------------------------------------- 请求翻译


VALID_ROLES = {"system", "developer", "user", "assistant", "tool", "function"}


def normalize_messages(raw: list) -> list[dict]:
    """把 OpenAI 的 messages 规整成上游能吃的形式。

    - developer 角色（OpenAI 新叫法）降级成 system，上游只认 system；
    - content 是字符串就原样，是数组（多模态）也原样透传，VL 模型能用；
    - 保留 tool_calls / tool_call_id / name，支持多轮工具调用。
    """
    out: list[dict] = []
    for idx, m in enumerate(raw):
        if not isinstance(m, dict):
            raise BadRequest(f"messages[{idx}] 必须是对象", f"messages[{idx}]")
        role = m.get("role")
        if role not in VALID_ROLES:
            raise BadRequest(f"messages[{idx}].role 不合法: {role!r}", f"messages[{idx}].role")
        if role == "developer":
            role = "system"

        content = m.get("content")
        if content is None:
            # 带 tool_calls 的 assistant 消息 content 可以是 null
            content = None if m.get("tool_calls") else ""
        elif not isinstance(content, (str, list)):
            raise BadRequest(f"messages[{idx}].content 必须是字符串或数组", f"messages[{idx}].content")

        item: dict = {"role": role, "content": content}
        if m.get("name"):
            item["name"] = m["name"]
        if m.get("tool_calls"):
            item["tool_calls"] = m["tool_calls"]
        if m.get("tool_call_id"):
            item["tool_call_id"] = m["tool_call_id"]
        out.append(item)
    return out


def translate_request(req: dict) -> tuple[list[dict], str, dict]:
    """OpenAI 请求 → (messages, 请求的模型名, 上游参数)。

    只翻译不改语义：不认识的字段直接忽略（OpenAI 服务端也是这么做的）。
    """
    messages = req.get("messages")
    if not isinstance(messages, list) or not messages:
        raise BadRequest("messages 必须是非空数组", "messages")
    msgs = normalize_messages(messages)

    # n 只支持 1：上游永远只回一个 choice，返回 2 个就是骗人
    n = req.get("n")
    if n is not None and n != 1:
        raise BadRequest("本代理只支持 n=1", "n", "unsupported_value")

    params: dict = {}
    for key in PASSTHROUGH_PARAMS:
        if req.get(key) is not None:
            params[key] = req[key]

    # OpenAI 的 max_tokens 已废弃，上游只认 max_completion_tokens
    if req.get("max_tokens") is not None:
        params["max_completion_tokens"] = req["max_tokens"]
    if req.get("max_completion_tokens") is not None:
        params["max_completion_tokens"] = req["max_completion_tokens"]

    # 客户端 tools 追加到模板 tools 后面；模板那 12 个是门禁要求，不能少
    client_tools = req.get("tools")
    if isinstance(client_tools, list) and client_tools:
        tpl_tools = _load_template().get("tools") or []
        used = {(t.get("function") or {}).get("name") for t in tpl_tools}
        extra = [t for t in client_tools if (t.get("function") or {}).get("name") not in used]
        params["tools"] = tpl_tools + extra

    return msgs, req.get("model") or "", params


# ---------------------------------------------------------------- 上游结果聚合


def collect(res) -> dict:
    """把流式 chunk 聚合成完整结果（非流式响应和旧版 completions 都用它）。"""
    content: list[str] = []
    reasoning: list[str] = []
    tool_calls: dict[int, dict] = {}
    usage: dict | None = None
    finish: str | None = None
    logprobs: list = []

    for data in iter_chunks(res):
        if data.get("usage"):
            usage = data["usage"]
        for ch in data.get("choices") or []:
            delta = ch.get("delta") or {}
            if delta.get("content"):
                content.append(delta["content"])
            if delta.get("reasoning_content"):
                reasoning.append(delta["reasoning_content"])
            # tool_calls 是分片下发的，按 index 合并 arguments
            for tc in delta.get("tool_calls") or []:
                i = tc.get("index", 0)
                slot = tool_calls.setdefault(
                    i,
                    {"id": None, "type": "function", "function": {"name": "", "arguments": ""}},
                )
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["function"]["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["function"]["arguments"] += fn["arguments"]
            lp = ch.get("logprobs")
            if isinstance(lp, dict) and lp.get("content"):
                logprobs.extend(lp["content"])
            if ch.get("finish_reason"):
                finish = ch["finish_reason"]

    calls = [tool_calls[i] for i in sorted(tool_calls)]
    for c in calls:
        if not c["id"]:
            c["id"] = _new_call_id()
        c["type"] = "function"

    return {
        "text": "".join(content),
        "reasoning": "".join(reasoning),
        "tool_calls": calls,
        "usage": usage,
        "finish": finish or ("tool_calls" if calls else "stop"),
        "logprobs": logprobs,
    }


# ---------------------------------------------------------------- HTTP 代理


class ProxyHandler(BaseHTTPRequestHandler):
    """OpenAI 兼容代理。所有响应都按 OpenAI 的 schema 拼，不直接透传上游。"""

    server_version = "opencode-api"
    protocol_version = "HTTP/1.1"
    timeout = 600

    # 由 serve() 注入
    default_model: str = DEFAULT_MODEL
    known_models: set[str] = set()
    api_key: str | None = None

    # --- 日志：只打一行，别把 SSE 刷屏

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[proxy] " + (fmt % args) + "\n")

    # --- 响应工具

    def _json(self, status: int, obj: dict, retry_after: str | None = None) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        if retry_after:
            self.send_header("Retry-After", retry_after)
        self.end_headers()
        self.wfile.write(data)

    def _error(
        self,
        status: int,
        message: str,
        type_: str = "invalid_request_error",
        param: str | None = None,
        code: str | None = None,
        retry_after: str | None = None,
    ) -> None:
        """OpenAI 错误体：error.message / type / param / code 四个字段齐全。"""
        self._json(
            status,
            {"error": {"message": message, "type": type_, "param": param, "code": code}},
            retry_after,
        )

    def _upstream_error(self, exc: APIError) -> None:
        """把上游错误翻译成 OpenAI 的错误类型。"""
        status = exc.status or 502
        message = str(exc)
        type_ = "api_error"
        code = None

        # 上游错误体形如 {"type":"error","error":{"type":"FreeUsageLimitError","message":"..."}}
        try:
            err = (json.loads(exc.body) or {}).get("error") or {}
            message = err.get("message") or message
            upstream_type = err.get("type") or ""
        except Exception:
            upstream_type = ""

        if status == 429:
            type_ = "rate_limit_error"
            code = "free_usage_limit" if upstream_type == "FreeUsageLimitError" else "rate_limit_exceeded"
        elif status == 401:
            code = "invalid_api_key"
        elif status == 404:
            code = "model_not_found"
        elif 400 <= status < 500:
            code = "invalid_request_error"

        # 额度用尽时把「去开关移动数据」这条提示带在 message 里，客户端能直接看到
        if exc.hint:
            message = f"{message} — {exc.hint}"

        # 429 的等待时间统一压到 10 秒，别让客户端干等十几分钟
        retry_after = RETRY_AFTER_429 if status == 429 else exc.retry_after

        self._error(status, message, type_, None, code, retry_after)

    # --- 鉴权

    def _authorized(self) -> bool:
        """没配 --api-key 就全放行；配了要求 Bearer 完全一致。"""
        if not self.api_key:
            return True
        auth = self.headers.get("Authorization") or ""
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else auth.strip()
        if token == self.api_key:
            return True
        self._error(
            401,
            "Incorrect API key provided. 本代理要求 Bearer <--api-key 指定的值>。",
            "invalid_request_error",
            None,
            "invalid_api_key",
        )
        return False

    # --- 模型名

    def _pick_model(self, requested: str | None) -> str:
        """客户端写死的模型名（gpt-4o 之类）不认识就回落到默认模型。"""
        if not requested:
            return self.default_model
        if not self.known_models or requested in self.known_models:
            return requested
        return self.default_model

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise BadRequest("请求体为空", "body")
        try:
            req = json.loads(self.rfile.read(length))
        except Exception:
            raise BadRequest("请求体不是合法 JSON", "body") from None
        if not isinstance(req, dict):
            raise BadRequest("请求体必须是 JSON 对象", "body")
        return req

    # --- CORS / 方法分发

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlsplit(self.path).path

        if path in ("/health", "/"):
            return self._json(200, {"status": "ok", "default_model": self.default_model})

        if not self._authorized():
            return

        if path in ("/v1/models", "/models"):
            try:
                models = list_models()
            except APIError as exc:
                return self._upstream_error(exc)
            return self._json(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": m["id"],
                            "object": "model",
                            "created": m.get("created", 0),
                            "owned_by": m.get("owned_by", "opencode"),
                        }
                        for m in models
                    ],
                },
            )

        # GET /v1/models/{model}
        for prefix in ("/v1/models/", "/models/"):
            if path.startswith(prefix):
                mid = unquote(path[len(prefix):])
                try:
                    models = list_models()
                except APIError as exc:
                    return self._upstream_error(exc)
                for m in models:
                    if m["id"] == mid:
                        return self._json(
                            200,
                            {
                                "id": m["id"],
                                "object": "model",
                                "created": m.get("created", 0),
                                "owned_by": m.get("owned_by", "opencode"),
                            },
                        )
                return self._error(
                    404,
                    f"The model '{mid}' does not exist.",
                    "invalid_request_error",
                    "model",
                    "model_not_found",
                )

        self._error(404, f"Unknown path: {path}", "invalid_request_error", None, "unknown_url")

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path in ("/v1/chat/completions", "/chat/completions"):
            return self._handle_chat()
        if path in ("/v1/completions", "/completions"):
            return self._handle_completions()
        self._error(404, f"Unknown path: {path}", "invalid_request_error", None, "unknown_url")

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, POST, OPTIONS")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        data = json.dumps(
            {"error": {"message": "Method not allowed", "type": "invalid_request_error", "param": None, "code": "method_not_allowed"}}
        ).encode()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_PUT = do_DELETE = do_PATCH = _method_not_allowed

    # --- POST /v1/chat/completions

    def _handle_chat(self) -> None:
        if not self._authorized():
            return
        try:
            req = self._read_json()
            messages, requested, params = translate_request(req)
        except BadRequest as exc:
            return self._error(400, str(exc), "invalid_request_error", exc.param, exc.code)

        model = self._pick_model(requested)
        try:
            res = open_stream(build_body(messages, model, params))
        except APIError as exc:
            return self._upstream_error(exc)

        include_usage = bool((req.get("stream_options") or {}).get("include_usage"))
        if req.get("stream"):
            self._stream_chat(res, model, include_usage)
        else:
            self._complete_chat(res, model)

    def _complete_chat(self, res, model: str) -> None:
        r = collect(res)
        message: dict = {
            "role": "assistant",
            # 有 tool_calls 时 content 按 OpenAI 规范为 null
            "content": r["text"] or (None if r["tool_calls"] else ""),
            "refusal": None,
            "annotations": [],
        }
        if r["tool_calls"]:
            message["tool_calls"] = r["tool_calls"]
        if r["reasoning"]:
            message["reasoning_content"] = r["reasoning"]  # 扩展字段

        self._json(
            200,
            {
                "id": "chatcmpl-" + secrets.token_hex(12),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "system_fingerprint": SYSTEM_FINGERPRINT,
                "choices": [
                    {
                        "index": 0,
                        "message": message,
                        "logprobs": {"content": r["logprobs"], "refusal": None} if r["logprobs"] else None,
                        "finish_reason": r["finish"],
                    }
                ],
                "usage": norm_usage(r["usage"]),
            },
        )

    def _start_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.close_connection = True

    def _sse(self, obj: dict) -> None:
        self.wfile.write(b"data: " + json.dumps(obj, ensure_ascii=False).encode() + b"\n\n")
        self.wfile.flush()

    def _stream_chat(self, res, model: str, include_usage: bool) -> None:
        cid = "chatcmpl-" + secrets.token_hex(12)
        created = int(time.time())
        self._start_sse()

        def chunk(delta: dict, finish: str | None = None, logprobs: dict | None = None) -> None:
            self._sse(
                {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "system_fingerprint": SYSTEM_FINGERPRINT,
                    "choices": [
                        {
                            "index": 0,
                            "delta": delta,
                            "logprobs": logprobs,
                            "finish_reason": finish,
                        }
                    ],
                }
            )

        # OpenAI 的第一个 chunk 固定是 role
        chunk({"role": "assistant", "content": ""})

        usage: dict | None = None
        finish: str | None = None
        seen_tc: set[int] = set()
        saw_tool = False

        try:
            for data in iter_chunks(res):
                if data.get("usage"):
                    usage = data["usage"]
                for ch in data.get("choices") or []:
                    delta = ch.get("delta") or {}
                    out: dict = {}
                    if delta.get("content"):
                        out["content"] = delta["content"]
                    if delta.get("reasoning_content"):
                        out["reasoning_content"] = delta["reasoning_content"]

                    # tool_calls 分片转发：第一次出现的 index 补上 id/type/name
                    tcs = []
                    for tc in delta.get("tool_calls") or []:
                        i = tc.get("index", 0)
                        fn = tc.get("function") or {}
                        if i not in seen_tc:
                            seen_tc.add(i)
                            saw_tool = True
                            tcs.append(
                                {
                                    "index": i,
                                    "id": tc.get("id") or _new_call_id(),
                                    "type": "function",
                                    "function": {
                                        "name": fn.get("name") or "",
                                        "arguments": fn.get("arguments") or "",
                                    },
                                }
                            )
                        else:
                            part: dict = {"index": i, "function": {}}
                            if fn.get("name"):
                                part["function"]["name"] = fn["name"]
                            if fn.get("arguments"):
                                part["function"]["arguments"] = fn["arguments"]
                            if part["function"]:
                                tcs.append(part)
                    if tcs:
                        out["tool_calls"] = tcs

                    lp = ch.get("logprobs")
                    if out or lp:
                        chunk(out, None, lp)
                    if ch.get("finish_reason"):
                        finish = ch["finish_reason"]
        except (BrokenPipeError, ConnectionResetError):
            # 客户端提前断开，直接结束，别在 stderr 刷堆栈
            return

        chunk({}, finish or ("tool_calls" if saw_tool else "stop"))

        # include_usage 时才发 usage chunk（OpenAI 的约定）
        if include_usage:
            self._sse(
                {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "system_fingerprint": SYSTEM_FINGERPRINT,
                    "choices": [],
                    "usage": norm_usage(usage),
                }
            )

        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    # --- POST /v1/completions（旧版，prompt → 单条 user 消息）

    def _handle_completions(self) -> None:
        if not self._authorized():
            return
        try:
            req = self._read_json()
        except BadRequest as exc:
            return self._error(400, str(exc), "invalid_request_error", exc.param, exc.code)

        prompt = req.get("prompt")
        if isinstance(prompt, list):
            prompt = "\n".join(str(p) for p in prompt)
        if prompt is None:
            prompt = ""
        if not isinstance(prompt, str):
            return self._error(400, "prompt 必须是字符串或字符串数组", "invalid_request_error", "prompt")

        n = req.get("n")
        if n is not None and n != 1:
            return self._error(400, "本代理只支持 n=1", "invalid_request_error", "n", "unsupported_value")

        params: dict = {}
        for key in ("temperature", "top_p", "stop", "presence_penalty", "frequency_penalty", "seed", "user"):
            if req.get(key) is not None:
                params[key] = req[key]
        if req.get("max_tokens") is not None:
            params["max_completion_tokens"] = req["max_tokens"]

        model = self._pick_model(req.get("model"))
        try:
            res = open_stream(build_body([{"role": "user", "content": prompt}], model, params))
        except APIError as exc:
            return self._upstream_error(exc)

        include_usage = bool((req.get("stream_options") or {}).get("include_usage"))
        if req.get("stream"):
            self._stream_text(res, model, include_usage)
        else:
            r = collect(res)
            self._json(
                200,
                {
                    "id": "cmpl-" + secrets.token_hex(12),
                    "object": "text_completion",
                    "created": int(time.time()),
                    "model": model,
                    "system_fingerprint": SYSTEM_FINGERPRINT,
                    "choices": [
                        {
                            "text": r["text"],
                            "index": 0,
                            "logprobs": None,
                            "finish_reason": r["finish"],
                        }
                    ],
                    "usage": norm_usage(r["usage"]),
                },
            )

    def _stream_text(self, res, model: str, include_usage: bool) -> None:
        cid = "cmpl-" + secrets.token_hex(12)
        created = int(time.time())
        self._start_sse()

        def chunk(text: str, finish: str | None = None) -> None:
            self._sse(
                {
                    "id": cid,
                    "object": "text_completion",
                    "created": created,
                    "model": model,
                    "system_fingerprint": SYSTEM_FINGERPRINT,
                    "choices": [
                        {"text": text, "index": 0, "logprobs": None, "finish_reason": finish}
                    ],
                }
            )

        usage: dict | None = None
        finish: str | None = None
        try:
            for data in iter_chunks(res):
                if data.get("usage"):
                    usage = data["usage"]
                for ch in data.get("choices") or []:
                    text = (ch.get("delta") or {}).get("content")
                    if text:
                        chunk(text)
                    if ch.get("finish_reason"):
                        finish = ch["finish_reason"]
        except (BrokenPipeError, ConnectionResetError):
            return

        chunk("", finish or "stop")
        if include_usage:
            self._sse(
                {
                    "id": cid,
                    "object": "text_completion",
                    "created": created,
                    "model": model,
                    "system_fingerprint": SYSTEM_FINGERPRINT,
                    "choices": [],
                    "usage": norm_usage(usage),
                }
            )
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve(host: str, port: int, default_model: str, api_key: str | None) -> int:
    ProxyHandler.default_model = default_model
    ProxyHandler.api_key = api_key
    try:
        ProxyHandler.known_models = {m["id"] for m in list_models()}
    except APIError as exc:
        print(f"[proxy] 拉模型列表失败，模型名不做校验：{exc}", file=sys.stderr)

    httpd = ProxyServer((host, port), ProxyHandler)
    base = f"http://{host}:{port}/v1"
    # flush=True：被 nohup 重定向到文件时 stdout 是块缓冲，不刷就看不到启动信息
    print(f"[proxy] OpenAI 兼容端点: {base}", flush=True)
    print(f"[proxy] 默认模型: {default_model}；模型数: {len(ProxyHandler.known_models) or '未知'}", flush=True)
    print(f"[proxy] 鉴权: {'Bearer ' + api_key if api_key else '不校验（任意 key 都行）'}", flush=True)
    print(f"[proxy] 示例: OPENAI_BASE_URL={base} OPENAI_API_KEY={api_key or 'sk-any'}", flush=True)
    if len(ROUTER) > 1:
        print(
            f"[proxy] 出口池: {len(ROUTER)} 个代理，每次请求轮换 IP + 池里下一个 session；"
            f"额度 429 时自动换下一个（最多 {_attempts()} 次）",
            flush=True,
        )
    else:
        print("[proxy] 出口池: 直连（只有本机 IP；配额耗尽需换 IP + session 才能继续）", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[proxy] 已停止")
    finally:
        httpd.server_close()
    return 0


# ---------------------------------------------------------------- 入口


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="单次调用 opencode 免费模型 / 查看模型列表 / OpenAI 兼容代理",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            '  python3 opencode-api.py "你好"\n'
            '  python3 opencode-api.py -m glm-5.3-flash-free "你好"\n'
            "  python3 opencode-api.py -l --free\n"
            "  python3 opencode-api.py serve\n"
            "  python3 opencode-api.py serve --port 8787 --proxies-file proxies.txt\n"
            "  python3 opencode-api.py --serve --api-key sk-local\n"
            "\n"
            "serve / server 等同于 --serve，可以直接放在最前面。"
        ),
    )
    parser.add_argument("prompt", nargs="*", help="问题；省略则从 stdin 读")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help=f"模型 id（默认 {DEFAULT_MODEL}）")
    parser.add_argument("-l", "--list", action="store_true", help="列出模型")
    parser.add_argument("--free", action="store_true", help="配合 -l：只列免费模型")
    parser.add_argument("--serve", action="store_true", help="起 OpenAI 兼容代理")
    parser.add_argument("--host", default="127.0.0.1", help="代理监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=8787, help="代理监听端口（默认 8787）")
    parser.add_argument("--api-key", default=None, help="设置后要求 Authorization: Bearer <key>")
    parser.add_argument(
        "--proxy",
        action="append",
        metavar="URL",
        help="出口代理，可重复；支持 http:// https:// socks5://，不写前缀按 http",
    )
    parser.add_argument("--proxies-file", metavar="PATH", help="从文件读代理列表，每行一个，# 开头为注释")

    # 子命令写法：serve / server 等价于 --serve，剩下的参数照常解析
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw and raw[0] in ("serve", "server"):
        raw[0] = "--serve"
    args = parser.parse_args(raw)

    # 代理池是全局的：CLI 和 --serve 都吃同一套配置
    global ROUTER
    proxies = parse_proxies(args.proxy, args.proxies_file)
    if proxies:
        ROUTER = Router(proxies)

    if args.serve:
        return serve(args.host, args.port, args.model, args.api_key)
    if args.list:
        return print_models(args.free)

    prompt = " ".join(args.prompt).strip() or sys.stdin.read().strip()
    if not prompt:
        parser.error("没有输入内容")
    if not TEMPLATE.exists():
        print(f"找不到模板 {TEMPLATE}（需要 OpenCode 原版 system prompt 和非空 tools）", file=sys.stderr)
        return 2

    try:
        ask(prompt, args.model)
    except APIError as exc:
        print(f"\n{exc}", file=sys.stderr)
        if exc.hint:
            print(f"\n提示：{exc.hint}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        os._exit(0)

    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
