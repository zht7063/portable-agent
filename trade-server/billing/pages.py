from urllib.parse import urlencode

from django.conf import settings
from django.contrib import messages
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST

from .models import Order, Package
from .services import BillingError, clean_user_id, create_order, get_balance


def yuan(cents: int) -> str:
    whole, fen = divmod(cents, 100)
    return f"{whole}.{fen:02d}"


def home_url(user_id: str) -> str:
    return f"{reverse('home')}?{urlencode({'user_id': user_id})}"


@require_GET
def home(request):
    raw_user_id = request.GET.get("user_id", "")
    context = {
        "raw_user_id": raw_user_id,
        "user_id": "",
        "balance": None,
        "packages": [],
        "orders": [],
    }
    if not raw_user_id.strip():
        return render(request, "billing/home.html", context)

    try:
        user_id = clean_user_id(raw_user_id)
    except BillingError as exc:
        messages.error(request, exc.message)
        return render(request, "billing/home.html", context)

    context["user_id"] = user_id
    context["balance"] = get_balance(user_id)
    context["packages"] = [
        {
            "id": package.id,
            "name": package.name,
            "price_yuan": yuan(package.price_cents),
            "credits": package.credits,
        }
        for package in Package.objects.filter(is_active=True)
    ]
    context["orders"] = [
        {
            "order_no": order.order_no,
            "package_name": order.package_name,
            "price_yuan": yuan(order.price_cents),
            "credits": order.credits,
            "status": order.status,
            "status_label": order.get_status_display(),
            "created_at": timezone.localtime(order.created_at).strftime("%Y-%m-%d %H:%M"),
            "api_key": order.api_key,
            "api_key_error": order.api_key_error,
        }
        for order in Order.objects.filter(user_id=user_id)[:20]
    ]
    context["relay_base_url"] = settings.NEWAPI_PUBLIC_BASE_URL
    return render(request, "billing/home.html", context)


@require_POST
def place_order(request):
    raw_user_id = request.POST.get("user_id", "")
    try:
        user_id = clean_user_id(raw_user_id)
        order = create_order(user_id, request.POST.get("package_id"))
    except BillingError as exc:
        messages.error(request, exc.message)
        if raw_user_id.strip():
            try:
                return redirect(home_url(clean_user_id(raw_user_id)))
            except BillingError:
                return redirect("home")
        return redirect("home")

    messages.success(
        request,
        f"已生成订单 {order.order_no}，等待确认收款后发放 API key。",
    )
    return redirect(home_url(order.user_id))
