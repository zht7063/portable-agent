from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from .models import LedgerEntry, Order, Package, UserAccount
from .newapi import NewAPIError, issue_key

# 一次转发固定扣 1 额度。以后按 token 用量计费时，只改这里。
CHARGE_CREDITS = 1


class BillingError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def clean_user_id(user_id) -> str:
    user_id = "" if user_id is None else str(user_id).strip()
    if not user_id:
        raise BillingError("user_id 不能为空")
    if len(user_id) > 64:
        raise BillingError("user_id 不能超过 64 个字符")
    return user_id


def clean_request_id(request_id) -> str:
    request_id = "" if request_id is None else str(request_id).strip()
    if not request_id:
        raise BillingError("request_id 不能为空")
    if len(request_id) > 128:
        raise BillingError("request_id 不能超过 128 个字符")
    return request_id


def create_order(user_id, package_id) -> Order:
    user_id = clean_user_id(user_id)
    try:
        package_id = int(package_id)
    except (TypeError, ValueError) as exc:
        raise BillingError("package_id 必须是整数") from exc

    try:
        package = Package.objects.get(pk=package_id, is_active=True)
    except Package.DoesNotExist as exc:
        raise BillingError("套餐不存在或已下架", status=404) from exc

    return Order.objects.create(
        user_id=user_id,
        package=package,
        package_name=package.name,
        price_cents=package.price_cents,
        credits=package.credits,
        status=Order.Status.PENDING,
        payment_method=settings.PAYMENT_PROVIDER,
    )


def claim_payment(order_id: int) -> Order:
    """用户点了“我已支付”。只做标记，到账与否仍由管理员或到账通知确认。"""
    Order.objects.filter(
        pk=order_id,
        status=Order.Status.PENDING,
        payer_claimed_at__isnull=True,
    ).update(payer_claimed_at=timezone.now())
    try:
        order = Order.objects.get(pk=order_id)
    except Order.DoesNotExist as exc:
        raise BillingError("订单不存在", status=404) from exc
    if order.status == Order.Status.CLOSED:
        raise BillingError("订单已取消")
    return order


def confirm_payment(order_no, method: str, amount_cents: int, payment_ref: str) -> Order:
    """收款渠道通知到账。金额必须和订单一致；同一笔通知重复到达只入账一次。"""
    try:
        order = Order.objects.get(order_no=order_no)
    except Order.DoesNotExist as exc:
        raise BillingError("订单不存在", status=404) from exc
    if amount_cents != order.price_cents:
        raise BillingError("到账金额和订单金额不一致", status=409)
    if order.status == Order.Status.PAID:
        if order.payment_ref and order.payment_ref != payment_ref:
            raise BillingError("订单已由另一笔付款确认", status=409)
        return order
    try:
        with transaction.atomic():
            Order.objects.filter(pk=order.pk, status=Order.Status.PENDING).update(
                payment_method=method,
                payment_ref=payment_ref,
            )
    except IntegrityError as exc:
        raise BillingError("这笔付款已经确认过另一笔订单", status=409) from exc
    return mark_order_paid(order.pk)


def get_account(user_id: str) -> UserAccount:
    try:
        return UserAccount.objects.get(user_id=user_id)
    except UserAccount.DoesNotExist:
        try:
            with transaction.atomic():
                return UserAccount.objects.create(user_id=user_id, balance=0)
        except IntegrityError:
            return UserAccount.objects.get(user_id=user_id)


def mark_order_paid(order_id: int) -> Order:
    """把待支付订单确认成已支付，并按订单快照入账。重复确认不会再次加额度。

    入账提交之后再向 New API 发 key。发 key 失败时订单仍保持已支付，可以再补发。
    """
    order = _settle_paid_order(order_id)
    issue_order_key(order)
    order.refresh_from_db()
    return order


def issue_order_key(order: Order) -> None:
    """给已支付且还没有 key 的订单发放 sk- key。"""
    order.refresh_from_db()
    if order.status != Order.Status.PAID or order.api_key:
        return
    if not settings.NEWAPI_BASE_URL:
        order.api_key_error = "未配置 New API，暂时不能发放 key"
        order.save(update_fields=["api_key_error"])
        return
    try:
        issue_key(order)
    except NewAPIError as exc:
        order.api_key_error = exc.message[:500]
        order.save(update_fields=["api_key_error"])


def _settle_paid_order(order_id: int) -> Order:
    with transaction.atomic():
        try:
            order = Order.objects.get(pk=order_id)
        except Order.DoesNotExist as exc:
            raise BillingError("订单不存在", status=404) from exc
        if order.status == Order.Status.PAID:
            return order
        if order.status != Order.Status.PENDING:
            raise BillingError("只有待支付订单可以确认支付")

        updated = Order.objects.filter(
            pk=order.pk,
            status=Order.Status.PENDING,
        ).update(status=Order.Status.PAID, paid_at=timezone.now())
        if updated != 1:
            order.refresh_from_db()
            if order.status == Order.Status.PAID:
                return order
            raise BillingError("只有待支付订单可以确认支付")

        account = get_account(order.user_id)
        UserAccount.objects.filter(pk=account.pk).update(
            balance=F("balance") + order.credits,
            updated_at=timezone.now(),
        )
        account.refresh_from_db()
        LedgerEntry.objects.create(
            kind=LedgerEntry.Kind.CREDIT,
            user_id=order.user_id,
            account=account,
            order_id=order.pk,
            credits=order.credits,
            balance_after=account.balance,
        )
        order.refresh_from_db()
        return order


def close_order(order_id: int) -> Order:
    with transaction.atomic():
        try:
            order = Order.objects.get(pk=order_id)
        except Order.DoesNotExist as exc:
            raise BillingError("订单不存在", status=404) from exc
        if order.status == Order.Status.CLOSED:
            return order
        if order.status != Order.Status.PENDING:
            raise BillingError("只有待支付订单可以关闭")

        updated = Order.objects.filter(
            pk=order.pk,
            status=Order.Status.PENDING,
        ).update(status=Order.Status.CLOSED, closed_at=timezone.now())
        if updated != 1:
            order.refresh_from_db()
            if order.status == Order.Status.CLOSED:
                return order
            raise BillingError("只有待支付订单可以关闭")
        order.refresh_from_db()
        return order


def get_balance(user_id: str) -> int:
    """没有账户表示还没有入账，余额就是 0。"""
    account = UserAccount.objects.filter(user_id=user_id).first()
    if account is None:
        return 0
    return account.balance


def charge(user_id, request_id) -> tuple[LedgerEntry, bool]:
    """扣一次转发的额度。返回流水，以及这次调用是否真正扣了费。"""
    user_id = clean_user_id(user_id)
    request_id = clean_request_id(request_id)
    try:
        with transaction.atomic():
            return _charge_once(user_id, request_id)
    except IntegrityError:
        entry = LedgerEntry.objects.get(request_id=request_id)
        if entry.user_id != user_id:
            raise BillingError("request_id 已被其他用户使用", status=409) from None
        return entry, False


def _charge_once(user_id: str, request_id: str) -> tuple[LedgerEntry, bool]:
    existing = LedgerEntry.objects.filter(request_id=request_id).first()
    if existing is not None:
        if existing.user_id != user_id:
            raise BillingError("request_id 已被其他用户使用", status=409)
        return existing, False

    account = UserAccount.objects.filter(user_id=user_id).first()
    if account is None or account.balance < CHARGE_CREDITS:
        raise BillingError("额度不足", status=402)

    updated = UserAccount.objects.filter(
        pk=account.pk,
        balance__gte=CHARGE_CREDITS,
    ).update(
        balance=F("balance") - CHARGE_CREDITS,
        updated_at=timezone.now(),
    )
    if updated != 1:
        raise BillingError("额度不足", status=402)

    account.refresh_from_db()
    entry = LedgerEntry.objects.create(
        kind=LedgerEntry.Kind.DEBIT,
        user_id=user_id,
        account=account,
        request_id=request_id,
        credits=CHARGE_CREDITS,
        balance_after=account.balance,
    )
    return entry, True


def charge_payload(entry: LedgerEntry, deducted: bool) -> dict:
    entry.account.refresh_from_db()
    return {
        "user_id": entry.user_id,
        "request_id": entry.request_id,
        "kind": entry.kind,
        "kind_label": entry.get_kind_display(),
        "credits": entry.credits,
        "balance_after": entry.balance_after,
        "balance": entry.account.balance,
        "deducted": deducted,
    }
