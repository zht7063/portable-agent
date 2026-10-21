"""向本机 New API 发放一把只属于这笔订单的 sk- key。"""

import json
import secrets
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings

from .models import Order


class NewAPIError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class _Client:
    def __init__(self, base_url: str, token: str = ""):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def login(self, username: str, password: str) -> str:
        payload = self.request(
            "POST",
            "/api/user/login",
            {"username": username, "password": password},
        )
        token = (payload.get("data") or {}).get("access_token")
        if not token:
            raise NewAPIError("New API 登录没有返回访问令牌")
        self.token = token
        return token

    def request(self, method: str, path: str, body=None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read().decode()
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            payload = _parse_json(raw)
            raise NewAPIError(_error_message(payload) or f"New API 返回 {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise NewAPIError(f"连不上 New API：{exc.reason}") from exc
        payload = _parse_json(raw)
        if not payload.get("success", False):
            raise NewAPIError(_error_message(payload) or "New API 拒绝了这次请求")
        return payload


def issue_key(order: Order) -> None:
    """给已支付订单发放 key。重复调用不会再次充额度，也不会再建一把 key。"""
    if order.api_key:
        return
    quota = order.credits * settings.NEWAPI_QUOTA_PER_CREDIT
    if quota <= 0:
        raise NewAPIError("订单额度不能换算成 New API 额度")

    _ensure_credentials(order)
    admin = _Client(settings.NEWAPI_BASE_URL)
    admin.login(settings.NEWAPI_ADMIN_USERNAME, settings.NEWAPI_ADMIN_PASSWORD)

    if not order.newapi_user_id:
        order.newapi_user_id = _create_user(
            admin,
            order.newapi_username,
            order.newapi_password,
        )
        order.save(update_fields=["newapi_user_id"])

    if not order.quota_granted:
        admin.request(
            "POST",
            "/api/user/manage",
            {
                "id": order.newapi_user_id,
                "action": "add_quota",
                "mode": "add",
                "value": quota,
            },
        )
        order.quota_granted = True
        order.save(update_fields=["quota_granted"])

    owner = _Client(settings.NEWAPI_BASE_URL)
    owner.login(order.newapi_username, order.newapi_password)
    order.api_key = _ensure_token(owner, order.order_no, quota)
    order.api_key_error = ""
    order.save(update_fields=["api_key", "api_key_error"])


def _ensure_credentials(order: Order) -> None:
    if order.newapi_username and order.newapi_password:
        return
    order.newapi_username = f"k{order.pk}"
    order.newapi_password = "Aa1!" + secrets.token_hex(8)
    order.save(update_fields=["newapi_username", "newapi_password"])


def _create_user(admin: _Client, username: str, password: str) -> int:
    try:
        admin.request(
            "POST",
            "/api/user/",
            {
                "username": username,
                "password": password,
                "display_name": username,
                "role": 1,
            },
        )
    except NewAPIError:
        existing = _find_user(admin, username)
        if existing is None:
            raise
        return existing
    created = _find_user(admin, username)
    if created is None:
        raise NewAPIError("New API 已创建用户，但没有查到用户编号")
    return created


def _find_user(admin: _Client, username: str) -> int | None:
    query = urllib.parse.urlencode({"keyword": username, "p": 1, "page_size": 10})
    payload = admin.request("GET", f"/api/user/search?{query}")
    for item in _items(payload):
        if item.get("username") == username:
            return int(item["id"])
    return None


def _ensure_token(owner: _Client, name: str, quota: int) -> str:
    existing = _find_token(owner, name)
    if existing is None:
        owner.request(
            "POST",
            "/api/token/",
            {
                "name": name,
                "remain_quota": quota,
                "unlimited_quota": False,
                "expired_time": -1,
            },
        )
        existing = _find_token(owner, name)
    if existing is None:
        raise NewAPIError("New API 已创建令牌，但没有查到令牌编号")
    payload = owner.request("POST", f"/api/token/{existing}/key")
    key = (payload.get("data") or {}).get("key") or ""
    if not key:
        raise NewAPIError("New API 没有返回 key")
    if not key.startswith("sk-"):
        key = "sk-" + key
    return key


def _find_token(owner: _Client, name: str) -> int | None:
    payload = owner.request("GET", "/api/token/")
    for item in _items(payload):
        if item.get("name") == name:
            return int(item["id"])
    return None


def _items(payload: dict) -> list:
    data = payload.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return items
    return []


def _parse_json(raw: str) -> dict:
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise NewAPIError("New API 返回的不是 JSON") from exc
    if not isinstance(payload, dict):
        raise NewAPIError("New API 返回的不是 JSON 对象")
    return payload


def _error_message(payload: dict) -> str:
    message = payload.get("message") or ""
    if isinstance(message, dict):
        message = message.get("message") or ""
    return str(message).strip()
