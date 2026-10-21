import secrets

from django.core.validators import MinValueValidator
from django.db import models
from django.utils import timezone


def new_order_no() -> str:
    """时间前缀加上随机串。唯一约束负责挡住极小概率的碰撞。"""
    return timezone.now().strftime("%Y%m%d%H%M%S") + secrets.token_hex(4)


class Package(models.Model):
    """在售额度套餐。价格单位是人民币分，credits 是到账额度。"""

    name = models.CharField("名称", max_length=64, unique=True)
    price_cents = models.PositiveIntegerField(
        "价格（分）",
        validators=[MinValueValidator(1)],
        help_text="人民币分。10 元写成 1000。",
    )
    credits = models.PositiveIntegerField(
        "额度",
        validators=[MinValueValidator(1)],
        help_text="支付成功后增加到用户余额的额度。",
    )
    is_active = models.BooleanField("在售", default=True)
    sort_order = models.PositiveIntegerField("排序", default=0)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)

    class Meta:
        verbose_name = "套餐"
        verbose_name_plural = "套餐"
        ordering = ["sort_order", "id"]

    def __str__(self) -> str:
        return self.name


class UserAccount(models.Model):
    """用户额度账户。余额等于入账减去扣费，不能在后台手改。"""

    user_id = models.CharField("用户标识", max_length=64, unique=True)
    balance = models.PositiveIntegerField("额度余额", default=0)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        verbose_name = "用户额度"
        verbose_name_plural = "用户额度"
        ordering = ["user_id"]

    def __str__(self) -> str:
        return f"{self.user_id}（{self.balance}）"


class Order(models.Model):
    """一笔购买。价格和额度在下单时写入快照，之后改套餐不影响这笔订单。"""

    class Status(models.TextChoices):
        PENDING = "pending", "待支付"
        PAID = "paid", "已支付"
        CLOSED = "closed", "已关闭"

    order_no = models.CharField("订单号", max_length=32, unique=True, blank=True)
    user_id = models.CharField(
        "用户标识",
        max_length=64,
        db_index=True,
        help_text="调用方传入的用户标识，不在这里注册账号。",
    )
    package = models.ForeignKey(
        Package,
        verbose_name="套餐",
        on_delete=models.PROTECT,
        related_name="orders",
    )
    package_name = models.CharField("套餐名称", max_length=64)
    price_cents = models.PositiveIntegerField("价格（分）")
    credits = models.PositiveIntegerField("额度")
    status = models.CharField(
        "状态",
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    paid_at = models.DateTimeField("支付时间", null=True, blank=True)
    closed_at = models.DateTimeField("关闭时间", null=True, blank=True)
    newapi_username = models.CharField("New API 用户名", max_length=20, blank=True)
    newapi_password = models.CharField("New API 密码", max_length=128, blank=True)
    newapi_user_id = models.PositiveIntegerField("New API 用户编号", null=True, blank=True)
    quota_granted = models.BooleanField("额度已充入", default=False)
    api_key = models.CharField("API key", max_length=256, blank=True)
    api_key_error = models.CharField("发 key 失败原因", max_length=500, blank=True)

    class Meta:
        verbose_name = "订单"
        verbose_name_plural = "订单"
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["user_id", "status"]),
        ]

    def __str__(self) -> str:
        return f"{self.order_no} {self.user_id} {self.get_status_display()}"

    def save(self, *args, **kwargs):
        if not self.order_no:
            self.order_no = new_order_no()
        if self.package_id and not self.package_name:
            self.package_name = self.package.name
            self.price_cents = self.package.price_cents
            self.credits = self.package.credits
        super().save(*args, **kwargs)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "order_no": self.order_no,
            "user_id": self.user_id,
            "package_id": self.package_id,
            "package_name": self.package_name,
            "price_cents": self.price_cents,
            "credits": self.credits,
            "status": self.status,
            "status_label": self.get_status_display(),
            "created_at": _local_iso(self.created_at),
            "paid_at": _local_iso(self.paid_at),
            "closed_at": _local_iso(self.closed_at),
            "api_key": self.api_key,
            "api_key_error": self.api_key_error,
        }


def _local_iso(value):
    if value is None:
        return None
    return timezone.localtime(value).isoformat()


class LedgerEntry(models.Model):
    """额度流水。入账对应一笔已支付订单，扣费对应一个 request_id。"""

    class Kind(models.TextChoices):
        CREDIT = "credit", "入账"
        DEBIT = "debit", "扣费"

    kind = models.CharField(
        "类型",
        max_length=16,
        choices=Kind.choices,
        default=Kind.CREDIT,
        db_index=True,
    )
    user_id = models.CharField("用户标识", max_length=64, db_index=True)
    account = models.ForeignKey(
        UserAccount,
        verbose_name="账户",
        on_delete=models.PROTECT,
        related_name="entries",
    )
    order = models.OneToOneField(
        Order,
        verbose_name="订单",
        on_delete=models.PROTECT,
        related_name="ledger_entry",
        null=True,
        blank=True,
    )
    request_id = models.CharField(
        "请求号",
        max_length=128,
        unique=True,
        null=True,
        blank=True,
        help_text="一次转发的请求号。同一个请求号只扣一次费。",
    )
    credits = models.PositiveIntegerField("额度", validators=[MinValueValidator(1)])
    balance_after = models.PositiveIntegerField("变动后余额")
    created_at = models.DateTimeField("记录时间", auto_now_add=True)

    class Meta:
        verbose_name = "额度流水"
        verbose_name_plural = "额度流水"
        ordering = ["-created_at", "-id"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(
                        kind="credit",
                        order__isnull=False,
                        request_id__isnull=True,
                    )
                    | models.Q(
                        kind="debit",
                        order__isnull=True,
                        request_id__isnull=False,
                    )
                ),
                name="billing_ledger_kind_source",
            )
        ]

    def __str__(self) -> str:
        sign = "-" if self.kind == self.Kind.DEBIT else "+"
        return f"{self.user_id} {sign}{self.credits} → {self.balance_after}"

    @property
    def signed_credits(self) -> int:
        if self.kind == self.Kind.DEBIT:
            return -self.credits
        return self.credits
