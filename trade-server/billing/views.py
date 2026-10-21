import json

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from .models import Order, Package
from .services import BillingError, charge, charge_payload, create_order, get_balance


def json_ok(data, status=200):
    return JsonResponse(data, status=status, json_dumps_params={"ensure_ascii": False})


def json_error(message, status=400):
    return JsonResponse(
        {"error": message},
        status=status,
        json_dumps_params={"ensure_ascii": False},
    )


def parse_body(request) -> dict:
    if not request.body:
        raise BillingError("请求体不能为空")
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError as exc:
        raise BillingError("请求体不是合法 JSON") from exc
    if not isinstance(data, dict):
        raise BillingError("请求体必须是 JSON 对象")
    return data


@require_GET
def package_list(request):
    packages = Package.objects.filter(is_active=True)
    return json_ok(
        {
            "packages": [
                {
                    "id": package.id,
                    "name": package.name,
                    "price_cents": package.price_cents,
                    "credits": package.credits,
                }
                for package in packages
            ]
        }
    )


@csrf_exempt
@require_POST
def order_create(request):
    """本机下单接口。确认支付在管理后台完成，这里不接收支付结果。"""
    try:
        data = parse_body(request)
        order = create_order(data.get("user_id"), data.get("package_id"))
    except BillingError as exc:
        return json_error(exc.message, exc.status)
    return json_ok(order.to_dict(), status=201)


@require_GET
def order_detail(request, order_id: int):
    try:
        order = Order.objects.get(pk=order_id)
    except Order.DoesNotExist:
        return json_error("订单不存在", status=404)
    return json_ok(order.to_dict())


@csrf_exempt
@require_POST
def charge_create(request):
    """扣一次转发额度。同一个 request_id 再调用不会重复扣费。"""
    try:
        data = parse_body(request)
        entry, deducted = charge(data.get("user_id"), data.get("request_id"))
    except BillingError as exc:
        return json_error(exc.message, exc.status)
    return json_ok(charge_payload(entry, deducted), status=201 if deducted else 200)


@require_GET
def balance(request):
    """返回入账减去扣费后的额度。没有账户时余额为 0。"""
    user_id = (request.GET.get("user_id") or "").strip()
    if not user_id:
        return json_error("user_id 不能为空")
    if len(user_id) > 64:
        return json_error("user_id 不能超过 64 个字符")
    return json_ok({"user_id": user_id, "balance": get_balance(user_id)})
