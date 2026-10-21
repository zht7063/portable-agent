from django import forms
from django.contrib import admin, messages
from django.db import transaction

from .models import LedgerEntry, Order, Package, UserAccount
from .services import BillingError, close_order, issue_order_key, mark_order_paid


def price_yuan(cents: int) -> str:
    yuan, fen = divmod(cents, 100)
    return f"{yuan}.{fen:02d}"


@admin.register(Package)
class PackageAdmin(admin.ModelAdmin):
    list_display = ("name", "price_yuan_display", "credits", "is_active", "sort_order")
    list_filter = ("is_active",)
    search_fields = ("name",)
    ordering = ("sort_order", "id")

    @admin.display(description="价格（元）", ordering="price_cents")
    def price_yuan_display(self, obj: Package) -> str:
        return price_yuan(obj.price_cents)


class OrderAdminForm(forms.ModelForm):
    class Meta:
        model = Order
        fields = "__all__"

    def clean(self):
        cleaned = super().clean()
        package = cleaned.get("package")
        if package and not self.instance.pk and not package.is_active:
            self.add_error("package", "套餐已下架")
        return cleaned


class AwaitingConfirmationFilter(admin.SimpleListFilter):
    title = "收款确认"
    parameter_name = "claimed"

    def lookups(self, request, model_admin):
        return (("yes", "用户已付款，待确认"), ("no", "用户未点已付款"))

    def queryset(self, request, queryset):
        pending = queryset.filter(status=Order.Status.PENDING)
        if self.value() == "yes":
            return pending.filter(payer_claimed_at__isnull=False)
        if self.value() == "no":
            return pending.filter(payer_claimed_at__isnull=True)
        return queryset


@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    form = OrderAdminForm
    list_display = (
        "order_no",
        "remark_code_display",
        "user_id",
        "package_name",
        "price_yuan_display",
        "status",
        "claimed_display",
        "api_key_ready",
        "created_at",
    )
    list_filter = (AwaitingConfirmationFilter, "status", "package")
    search_fields = ("order_no", "user_id", "package_name", "api_key", "payment_ref")
    date_hierarchy = "created_at"
    actions = ("confirm_payment", "reissue_api_keys", "close_orders")

    def get_fields(self, request, obj=None):
        if obj is None:
            return ["user_id", "package", "status"]
        return [
            "order_no",
            "user_id",
            "package",
            "status",
            "package_name",
            "price_cents",
            "credits",
            "created_at",
            "paid_at",
            "closed_at",
            "payment_method",
            "payer_claimed_at",
            "payment_ref",
            "api_key",
            "api_key_error",
        ]

    def get_readonly_fields(self, request, obj=None):
        if obj is None:
            return []
        readonly = [
            "order_no",
            "package_name",
            "price_cents",
            "credits",
            "created_at",
            "paid_at",
            "closed_at",
            "payment_method",
            "payer_claimed_at",
            "payment_ref",
            "api_key",
            "api_key_error",
        ]
        if obj.status != Order.Status.PENDING:
            readonly += ["user_id", "package", "status"]
        return readonly

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description="价格（元）", ordering="price_cents")
    def price_yuan_display(self, obj: Order) -> str:
        if obj.price_cents is None:
            return "-"
        return price_yuan(obj.price_cents)

    def save_model(self, request, obj, form, change):
        becoming_paid = obj.status == Order.Status.PAID and (
            not change or "status" in form.changed_data
        )
        becoming_closed = obj.status == Order.Status.CLOSED and (
            not change or "status" in form.changed_data
        )
        if becoming_paid or becoming_closed:
            obj.status = Order.Status.PENDING
        if (not change) or ("package" in form.changed_data):
            obj.package_name = obj.package.name
            obj.price_cents = obj.package.price_cents
            obj.credits = obj.package.credits
        try:
            with transaction.atomic():
                super().save_model(request, obj, form, change)
                if becoming_paid:
                    mark_order_paid(obj.pk)
                elif becoming_closed:
                    close_order(obj.pk)
        except BillingError as exc:
            self.message_user(request, exc.message, level=messages.ERROR)

    @admin.display(description="付款备注", ordering="order_no")
    def remark_code_display(self, obj: Order) -> str:
        return obj.remark_code if obj.order_no else "-"

    @admin.display(description="用户已付款", boolean=True, ordering="payer_claimed_at")
    def claimed_display(self, obj: Order) -> bool:
        return obj.payer_claimed_at is not None

    @admin.display(description="API key", boolean=True)
    def api_key_ready(self, obj: Order) -> bool:
        return bool(obj.api_key)

    @admin.action(description="确认支付")
    def confirm_payment(self, request, queryset):
        paid = 0
        skipped = 0
        key_failed = 0
        for order in queryset:
            already_paid = order.status == Order.Status.PAID
            try:
                updated = mark_order_paid(order.pk)
            except BillingError:
                skipped += 1
                continue
            if already_paid:
                skipped += 1
            else:
                paid += 1
            if updated.status == Order.Status.PAID and not updated.api_key:
                key_failed += 1
        message = f"已确认支付 {paid} 笔，跳过 {skipped} 笔。"
        if key_failed:
            message += f" {key_failed} 笔未能发放 API key。"
        self.message_user(request, message)

    @admin.action(description="补发 API key")
    def reissue_api_keys(self, request, queryset):
        issued = 0
        failed = 0
        skipped = 0
        for order in queryset:
            if order.status != Order.Status.PAID or order.api_key:
                skipped += 1
                continue
            issue_order_key(order)
            order.refresh_from_db()
            if order.api_key:
                issued += 1
            else:
                failed += 1
        self.message_user(
            request,
            f"已补发 {issued} 把 API key，失败 {failed} 笔，跳过 {skipped} 笔。",
        )

    @admin.action(description="关闭订单")
    def close_orders(self, request, queryset):
        closed = 0
        skipped = 0
        for order in queryset:
            already_closed = order.status == Order.Status.CLOSED
            try:
                close_order(order.pk)
            except BillingError:
                skipped += 1
                continue
            if already_closed:
                skipped += 1
            else:
                closed += 1
        self.message_user(request, f"已关闭 {closed} 笔，跳过 {skipped} 笔。")


@admin.register(UserAccount)
class UserAccountAdmin(admin.ModelAdmin):
    list_display = ("user_id", "balance", "updated_at")
    search_fields = ("user_id",)
    readonly_fields = ("user_id", "balance", "updated_at")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(LedgerEntry)
class LedgerEntryAdmin(admin.ModelAdmin):
    list_display = (
        "created_at",
        "user_id",
        "kind",
        "signed_credits_display",
        "balance_after",
        "order",
        "request_id",
    )
    list_filter = ("kind",)
    search_fields = ("user_id", "order__order_no", "request_id")
    readonly_fields = (
        "kind",
        "user_id",
        "account",
        "order",
        "request_id",
        "credits",
        "balance_after",
        "created_at",
    )

    @admin.display(description="变动")
    def signed_credits_display(self, obj: LedgerEntry) -> str:
        sign = "-" if obj.kind == LedgerEntry.Kind.DEBIT else "+"
        return f"{sign}{obj.credits}"

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
