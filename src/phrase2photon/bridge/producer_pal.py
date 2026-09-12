from __future__ import annotations

import json
import socket
from dataclasses import dataclass
from typing import Any
from urllib import error, request

import json5


class ProducerPalError(RuntimeError):
    """Raised when Producer Pal reports an error or returns invalid data."""


@dataclass(slots=True)
class ProducerPalToolResult:
    tool_name: str
    payload: dict[str, Any]
    is_error: bool
    result_raw: str
    result: Any


@dataclass(slots=True)
class ProducerPalClient:
    """Minimal local REST client for Producer Pal."""

    base_url: str = "http://localhost:3350"
    timeout_seconds: float = 30.0

    def _request_json(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = request.Request(
            url=f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST" if payload is not None else "GET",
        )
        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise ProducerPalError(f"Producer Pal HTTP {exc.code} for {path}: {body}") from exc
        except TimeoutError as exc:
            raise ProducerPalError(f"Producer Pal request timed out for {path}") from exc
        except socket.timeout as exc:
            raise ProducerPalError(f"Producer Pal request timed out for {path}") from exc
        except error.URLError as exc:
            raise ProducerPalError(f"Producer Pal request failed for {path}: {exc}") from exc

    def list_tools(self) -> dict[str, Any]:
        return self._request_json("/api/tools")

    def connect(self) -> ProducerPalToolResult:
        return self.call_tool("ppal-connect")

    def call_tool(self, tool_name: str, payload: dict[str, Any] | None = None) -> ProducerPalToolResult:
        response = self._request_json(f"/api/tools/{tool_name}", payload or {})
        result_raw = response.get("result", "")
        tool_result = ProducerPalToolResult(
            tool_name=tool_name,
            payload=payload or {},
            is_error=bool(response.get("isError", False)),
            result_raw=result_raw,
            result=parse_ppal_result(result_raw),
        )
        if tool_result.is_error:
            raise ProducerPalError(f"Producer Pal tool {tool_name} failed: {tool_result.result_raw}")
        return tool_result

    def read_live_set(self) -> dict[str, Any]:
        return self.call_tool("ppal-read-live-set").result

    def read_live_set_with_include(self, include: list[str]) -> dict[str, Any]:
        return self.call_tool("ppal-read-live-set", {"include": include}).result

    def read_track(self, track_index: int, include: list[str] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"trackIndex": track_index}
        if include:
            payload["include"] = include
        return self.call_tool("ppal-read-track", payload).result


def parse_ppal_result(result_raw: str) -> Any:
    text = result_raw.strip()
    if not text:
        return None

    try:
        return json5.loads(text)
    except ValueError:
        return text
