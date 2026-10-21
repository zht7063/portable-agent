from django.conf import settings
from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.contrib.auth.views import LoginView
from django.http import FileResponse, Http404, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .forms import SignInForm, SignUpForm
from .models import Order, Package
from .payments import PaymentError, get_provider
from .services import BillingError, claim_payment, close_order, create_order, get_balance

PACKAGE_NOTES = {
    "入门包": "适合先确认调用是否正常",
    "标准包": "适合日常使用",
    "进阶包": "适合持续使用",
}
FEATURED_PACKAGE = "标准包"


def yuan(cents: int) -> str:
    whole, fen = divmod(cents, 100)
    return f"{whole}.{fen:02d}"


def order_card(order: Order) -> dict:
    status_label = order.get_status_display()
    if order.awaiting_confirmation:
        status_label = "待确认"
    return {
        "order_no": order.order_no,
        "remark_code": order.remark_code,
        "package_name": order.package_name,
        "price_yuan": yuan(order.price_cents),
        "credits": order.credits,
        "status": order.status,
        "status_label": status_label,
        "claimed": order.payer_claimed_at is not None,
        "created_at": timezone.localtime(order.created_at).strftime("%Y-%m-%d %H:%M"),
        "api_key": order.api_key,
        "api_key_error": order.api_key_error,
    }


def own_order(request, order_no: str) -> Order:
    return get_object_or_404(
        Order, order_no=order_no, user_id=request.user.get_username()
    )


class SignInView(LoginView):
    template_name = "billing/login.html"
    authentication_form = SignInForm
    redirect_authenticated_user = True


@require_http_methods(["GET", "POST"])
def sign_up(request):
    if request.user.is_authenticated:
        return redirect("home")
    form = SignUpForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        login(request, user)
        return redirect("home")
    return render(request, "billing/register.html", {"form": form})


@require_GET
@login_required
def home(request):
    user_id = request.user.get_username()
    context = {
        "user_id": user_id,
        "balance": get_balance(user_id),
        "packages": [
            {
                "id": package.id,
                "name": package.name,
                "price_yuan": yuan(package.price_cents),
                "credits": package.credits,
                "note": PACKAGE_NOTES.get(package.name, ""),
                "featured": package.name == FEATURED_PACKAGE,
            }
            for package in Package.objects.filter(is_active=True)
        ],
        "orders": [order_card(order) for order in Order.objects.filter(user_id=user_id)[:20]],
        "relay_base_url": settings.NEWAPI_PUBLIC_BASE_URL,
    }
    return render(request, "billing/home.html", context)


@require_POST
@login_required
def place_order(request):
    try:
        order = create_order(request.user.get_username(), request.POST.get("package_id"))
    except BillingError as exc:
        messages.error(request, exc.message)
        return redirect("home")
    return redirect("checkout", order_no=order.order_no)


@require_GET
@login_required
def checkout(request, order_no):
    order = own_order(request, order_no)
    context = {
        "user_id": request.user.get_username(),
        "order": order_card(order),
        "relay_base_url": settings.NEWAPI_PUBLIC_BASE_URL,
    }
    if order.status == Order.Status.PENDING:
        try:
            context["checkout"] = get_provider(order.payment_method or None).checkout(order)
        except PaymentError as exc:
            context["checkout_error"] = exc.message
    return render(request, "billing/checkout.html", context)


@require_POST
@login_required
def claim_order_payment(request, order_no):
    order = own_order(request, order_no)
    try:
        claim_payment(order.pk)
    except BillingError as exc:
        messages.error(request, exc.message)
    return redirect("checkout", order_no=order.order_no)


@require_POST
@login_required
def cancel_order(request, order_no):
    order = own_order(request, order_no)
    try:
        close_order(order.pk)
    except BillingError as exc:
        messages.error(request, exc.message)
    return redirect("checkout", order_no=order.order_no)


@require_GET
@login_required
def order_status(request, order_no):
    order = own_order(request, order_no)
    return JsonResponse(
        {"status": order.status, "claimed": order.payer_claimed_at is not None}
    )


@require_GET
@login_required
def payment_qr(request):
    path = settings.PAYMENT_QR_IMAGE
    if not path.is_file():
        raise Http404("收款码图片不存在")
    response = FileResponse(path.open("rb"), content_type="image/jpeg")
    response["Cache-Control"] = "private, max-age=300"
    return response
