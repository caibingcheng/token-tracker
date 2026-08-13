#!/usr/bin/env python3
"""
Lightweight gateway connectivity test for Token Tracker.

Supports OpenAI, Anthropic and Gemini protocols through the gateway's
/v1 and /v1beta catch-all routes. Only uses Python standard library.

Usage:
    python3 scripts/test_gateway.py <url> <vk> <model> [protocol] [stream]

Examples:
    python3 scripts/test_gateway.py http://localhost:3000 vk-xxx gpt-4o-mini
    python3 scripts/test_gateway.py http://localhost:3000 vk-xxx claude-3-5-sonnet anthropic
    python3 scripts/test_gateway.py http://localhost:3000 vk-xxx gemini-1.5-flash gemini
    python3 scripts/test_gateway.py http://localhost:3000 vk-xxx gpt-4o-mini openai stream
"""

import json
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Tuple


def eprint(*args: Any, **kwargs: Any) -> None:
    print(*args, file=sys.stderr, **kwargs)


def print_usage() -> None:
    eprint(__doc__)


def build_request(
    url: str, vk: str, model: str, protocol: str, stream: bool
) -> Tuple[str, Dict[str, str], bytes]:
    if protocol == "openai":
        endpoint = f"{url.rstrip('/')}/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {vk}",
            "Content-Type": "application/json",
            # 默认 UA 为 Python-urllib/x.y，会被部分上游（如 opencode.ai 的 Cloudflare）
            # 按浏览器签名封禁返回 403，显式声明通用 UA 规避
            "User-Agent": "Mozilla/5.0 (compatible; opencode-test/1.0)",
        }
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "hi, reply in one word"},
            ],
            "max_tokens": 100,
        }
        if stream:
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}
    elif protocol == "anthropic":
        endpoint = f"{url.rstrip('/')}/v1/messages"
        headers = {
            "Authorization": f"Bearer {vk}",
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
        }
        body = {
            "model": model,
            "system": "You are a helpful assistant.",
            "messages": [
                {"role": "user", "content": "hi, reply in one word"},
            ],
            "max_tokens": 100,
        }
        if stream:
            body["stream"] = True
    elif protocol == "gemini":
        if stream:
            endpoint = f"{url.rstrip('/')}/v1beta/models/{model}:streamGenerateContent?alt=sse"
        else:
            endpoint = f"{url.rstrip('/')}/v1beta/models/{model}:generateContent"
        headers = {
            "x-goog-api-key": vk,
            "Content-Type": "application/json",
        }
        body = {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": "hi, reply in one word"}],
                }
            ]
        }
    else:
        raise ValueError(f"unsupported protocol: {protocol}")

    return endpoint, headers, json.dumps(body).encode("utf-8")


def extract_openai(data: Dict[str, Any]) -> Tuple[str, Dict[str, int]]:
    choices = data.get("choices", [])
    text = ""
    if choices and isinstance(choices[0], dict):
        msg = choices[0].get("message", {})
        text = msg.get("content", "") if isinstance(msg, dict) else ""
    usage = data.get("usage", {}) or {}
    return text, {
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
    }


def extract_anthropic(data: Dict[str, Any]) -> Tuple[str, Dict[str, int]]:
    content = data.get("content", [])
    text = ""
    if content and isinstance(content[0], dict):
        text = content[0].get("text", "")
    usage = data.get("usage", {}) or {}
    return text, {
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
    }


def extract_gemini(data: Dict[str, Any]) -> Tuple[str, Dict[str, int]]:
    candidates = data.get("candidates", [])
    text = ""
    if candidates and isinstance(candidates[0], dict):
        content = candidates[0].get("content", {})
        if isinstance(content, dict):
            parts = content.get("parts", [])
            if parts and isinstance(parts[0], dict):
                text = parts[0].get("text", "")
    usage = data.get("usageMetadata", {}) or {}
    return text, {
        "input_tokens": usage.get("promptTokenCount", 0),
        "output_tokens": usage.get("candidatesTokenCount", 0),
        "total_tokens": usage.get("totalTokenCount", 0),
    }


def extract(protocol: str, data: Dict[str, Any]) -> Tuple[str, Dict[str, int]]:
    if protocol == "openai":
        return extract_openai(data)
    if protocol == "anthropic":
        return extract_anthropic(data)
    if protocol == "gemini":
        return extract_gemini(data)
    raise ValueError(f"unsupported protocol: {protocol}")


def apply_usage(protocol: str, usage: Dict[str, int], data: Dict[str, Any]) -> None:
    """Merge usage from a stream chunk into `usage` (last non-empty wins)."""
    if protocol == "openai":
        u = data.get("usage") or {}
        if u.get("prompt_tokens") is not None:
            usage["input_tokens"] = u.get("prompt_tokens", 0)
            usage["output_tokens"] = u.get("completion_tokens", 0)
            usage["total_tokens"] = u.get("total_tokens", 0)
    elif protocol == "anthropic":
        u = data.get("usage") or {}
        if u.get("input_tokens") is not None:
            usage["input_tokens"] = u.get("input_tokens", 0)
            usage["output_tokens"] = u.get("output_tokens", 0)
            usage["total_tokens"] = usage["input_tokens"] + usage["output_tokens"]
    elif protocol == "gemini":
        u = data.get("usageMetadata") or {}
        if u.get("promptTokenCount") is not None:
            usage["input_tokens"] = u.get("promptTokenCount", 0)
            usage["output_tokens"] = u.get("candidatesTokenCount", 0)
            usage["total_tokens"] = u.get("totalTokenCount", 0)


def chunk_text_delta(protocol: str, data: Dict[str, Any]) -> str:
    """Return the incremental text carried by one stream chunk."""
    if protocol == "openai":
        choices = data.get("choices") or []
        if choices and isinstance(choices[0], dict):
            delta = choices[0].get("delta") or {}
            if isinstance(delta, dict):
                return delta.get("content") or ""
    elif protocol == "anthropic":
        if data.get("type") == "content_block_delta":
            delta = data.get("delta") or {}
            if isinstance(delta, dict) and delta.get("type") == "text_delta":
                return delta.get("text") or ""
    elif protocol == "gemini":
        candidates = data.get("candidates") or []
        if candidates and isinstance(candidates[0], dict):
            content = candidates[0].get("content") or {}
            if isinstance(content, dict):
                parts = content.get("parts") or []
                if parts and isinstance(parts[0], dict):
                    return parts[0].get("text") or ""
    return ""


def consume_stream(resp: Any, protocol: str) -> Tuple[str, Dict[str, int]]:
    """Read an SSE stream line by line, collecting text and usage."""
    text = ""
    usage: Dict[str, int] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    for line in resp:
        line = line.decode("utf-8", errors="replace").strip()
        if not line or not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            break
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        text += chunk_text_delta(protocol, data)
        apply_usage(protocol, usage, data)
        if protocol == "anthropic" and data.get("type") == "message_stop":
            break
    return text.strip(), usage


def main() -> int:
    if len(sys.argv) < 4:
        print_usage()
        return 1

    url = sys.argv[1]
    vk = sys.argv[2]
    model = sys.argv[3]
    protocol = (sys.argv[4] if len(sys.argv) > 4 else "openai").lower()
    stream = (
        len(sys.argv) > 5
        and sys.argv[5].lower() in ("stream", "--stream", "true", "1")
    )

    if protocol not in ("openai", "anthropic", "gemini"):
        eprint(f"error: unknown protocol '{protocol}'. use openai|anthropic|gemini")
        return 1

    endpoint, headers, payload = build_request(url, vk, model, protocol, stream)

    print(f"protocol: {protocol}")
    print(f"streaming: {'yes' if stream else 'no'}")
    print(f"endpoint: {endpoint}")

    req = urllib.request.Request(
        endpoint,
        data=payload,
        headers=headers,
        method="POST",
    )

    status = 0
    streamed_text = ""
    streamed_usage: Dict[str, int] = {}
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = resp.status
            if stream:
                streamed_text, streamed_usage = consume_stream(resp, protocol)
                body = b""
            else:
                body = resp.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        body = exc.read()
    except urllib.error.URLError as exc:
        eprint(f"error: request failed: {exc.reason}")
        return 1

    print(f"status: {status}")
    print()

    if stream:
        if status < 200 or status >= 300:
            eprint("error: non-2xx response")
            try:
                eprint(json.dumps(json.loads(body.decode("utf-8")), indent=2, ensure_ascii=False))
            except json.JSONDecodeError:
                eprint(body.decode("utf-8", errors="replace"))
            return 1
        print("reply:", streamed_text if streamed_text else "(empty)")
        print()
        print("usage:")
        for key, value in streamed_usage.items():
            print(f"  {key}: {value}")
        return 0

    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        eprint(f"error: failed to parse response as JSON: {exc}")
        eprint("raw response:")
        eprint(body.decode("utf-8", errors="replace"))
        return 1

    if status < 200 or status >= 300:
        eprint("error: non-2xx response")
        eprint(json.dumps(data, indent=2, ensure_ascii=False))
        return 1

    try:
        text, usage = extract(protocol, data)
    except Exception as exc:
        eprint(f"error: failed to extract reply/usage: {exc}")
        eprint("raw response:")
        eprint(json.dumps(data, indent=2, ensure_ascii=False))
        return 1

    print("reply:", text.strip() if text else "(empty)")
    print()
    print("usage:")
    for key, value in usage.items():
        print(f"  {key}: {value}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
