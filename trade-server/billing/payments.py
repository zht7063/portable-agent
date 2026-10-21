"""收款方式。

现在只有个人收款码：用户扫码付款后点“我已支付”，管理员在后台确认收款。

开通微信支付或支付宝商户号后，在这里新写一个收款方式，然后把 PAYMENT_PROVIDER 改成它：
- checkout() 调商户接口下单，返回这笔订单专属的二维码，needs_buyer_claim 为 False；
- parse_notify() 校验到账通知的签名，取出订单号、实付金额（分）和支付流水号；
- notify_ack() 返回平台要求的成功应答。
/api/payments/notify/<code>/ 收到通知后调用 services.confirm_payment 入账并发 key。
"""

from dataclasses import dataclass

from django.conf import settings
from django.http import HttpResponse
from django.urls import reverse


class PaymentError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class Checkout:
    qr_image_url: str
    needs_buyer_claim: bool


@dataclass(frozen=True)
class PaymentNotice:
    order_no: str
    amount_cents: int
    payment_ref: str


class PaymentProvider:
    code = ""
    label = ""

    def checkout(self, order) -> Checkout:
        raise NotImplementedError

    def parse_notify(self, request) -> PaymentNotice:
        raise PaymentError(f"{self.label}没有到账通知")

    def notify_ack(self) -> HttpResponse:
        return HttpResponse("success")


class ManualQRProvider(PaymentProvider):
    code = "manual_qr"
    label = "微信收款码"

    def checkout(self, order) -> Checkout:
        return Checkout(qr_image_url=reverse("payment-qr"), needs_buyer_claim=True)


PROVIDERS = {provider.code: provider for provider in (ManualQRProvider(),)}


def get_provider(code: str | None = None) -> PaymentProvider:
    code = code or settings.PAYMENT_PROVIDER
    try:
        return PROVIDERS[code]
    except KeyError as exc:
        raise PaymentError(f"未知的收款方式 {code}") from exc
