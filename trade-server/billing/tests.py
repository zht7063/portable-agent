import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse

from billing.models import LedgerEntry, Order, Package, UserAccount
from billing.payments import PROVIDERS, Checkout, PaymentNotice, PaymentProvider
from billing.services import (
    BillingError,
    charge,
    close_order,
    create_order,
    get_balance,
    mark_order_paid,
)


class SeedPackageTests(TestCase):
    def test_seeded_packages(self):
        rows = list(
            Package.objects.filter(is_active=True).values_list(
                "name", "price_cents", "credits"
            )
        )
        self.assertEqual(
            rows,
            [
                ("入门包", 1000, 100),
                ("标准包", 5000, 600),
                ("进阶包", 10000, 1500),
            ],
        )


class OrderFlowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.starter = Package.objects.get(name="入门包")

    def test_create_order_snapshots_package(self):
        order = create_order("user-1", self.starter.id)
        self.starter.credits = 999
        self.starter.price_cents = 1
        self.starter.save(update_fields=["credits", "price_cents"])

        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.PENDING)
        self.assertEqual(order.credits, 100)
        self.assertEqual(order.price_cents, 1000)
        self.assertEqual(order.package_name, "入门包")

    def test_mark_paid_credits_once(self):
        order = create_order("user-1", self.starter.id)
        mark_order_paid(order.pk)
        mark_order_paid(order.pk)

        account = UserAccount.objects.get(user_id="user-1")
        entry = LedgerEntry.objects.get(order=order)
        self.assertEqual(account.balance, 100)
        self.assertEqual(entry.kind, LedgerEntry.Kind.CREDIT)
        self.assertEqual(entry.credits, 100)
        self.assertEqual(entry.balance_after, 100)
        self.assertIsNone(entry.request_id)
        self.assertEqual(LedgerEntry.objects.filter(order=order).count(), 1)
        self.assertEqual(get_balance("user-1"), 100)
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.PAID)
        self.assertIsNotNone(order.paid_at)

    def test_two_orders_accumulate(self):
        first = create_order("user-1", self.starter.id)
        second = create_order("user-1", self.starter.id)
        mark_order_paid(first.pk)
        mark_order_paid(second.pk)

        balances = list(
            LedgerEntry.objects.filter(user_id="user-1")
            .order_by("id")
            .values_list("balance_after", flat=True)
        )
        self.assertEqual(balances, [100, 200])
        self.assertEqual(get_balance("user-1"), 200)

    def test_later_package_edit_does_not_change_paid_credits(self):
        order = create_order("user-1", self.starter.id)
        self.starter.credits = 1
        self.starter.save(update_fields=["credits"])

        mark_order_paid(order.pk)
        self.assertEqual(get_balance("user-1"), 100)

    def test_close_does_not_credit_and_cannot_be_paid(self):
        order = create_order("user-1", self.starter.id)
        close_order(order.pk)

        self.assertEqual(get_balance("user-1"), 0)
        self.assertFalse(UserAccount.objects.filter(user_id="user-1").exists())
        self.assertEqual(LedgerEntry.objects.count(), 0)
        with self.assertRaises(BillingError):
            mark_order_paid(order.pk)
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.CLOSED)

    def test_cannot_close_paid_order(self):
        order = create_order("user-1", self.starter.id)
        mark_order_paid(order.pk)

        with self.assertRaises(BillingError):
            close_order(order.pk)
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.PAID)
        self.assertEqual(get_balance("user-1"), 100)

    def test_inactive_and_unknown_package_rejected(self):
        self.starter.is_active = False
        self.starter.save(update_fields=["is_active"])
        with self.assertRaises(BillingError) as inactive:
            create_order("user-1", self.starter.id)
        self.assertEqual(inactive.exception.status, 404)

        with self.assertRaises(BillingError) as missing:
            create_order("user-1", 99999)
        self.assertEqual(missing.exception.status, 404)

    def test_blank_user_id_rejected(self):
        with self.assertRaises(BillingError):
            create_order("   ", self.starter.id)


class ApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.starter = Package.objects.get(name="入门包")

    def test_package_list_hides_inactive(self):
        self.starter.is_active = False
        self.starter.save(update_fields=["is_active"])

        response = self.client.get(reverse("billing:package-list"))
        self.assertEqual(response.status_code, 200)
        names = [item["name"] for item in response.json()["packages"]]
        self.assertEqual(names, ["标准包", "进阶包"])
        self.assertEqual(response.json()["packages"][0]["price_cents"], 5000)
        self.assertEqual(response.json()["packages"][0]["credits"], 600)

    def test_create_order_then_balance_changes_only_after_payment(self):
        response = self.client.post(
            reverse("billing:order-create"),
            data=json.dumps({"user_id": "api-user", "package_id": self.starter.id}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["status"], "pending")
        self.assertEqual(body["status_label"], "待支付")
        self.assertEqual(body["credits"], 100)
        self.assertEqual(body["price_cents"], 1000)

        before = self.client.get(reverse("billing:balance"), {"user_id": "api-user"})
        self.assertEqual(before.json(), {"user_id": "api-user", "balance": 0})

        mark_order_paid(body["id"])
        after = self.client.get(reverse("billing:balance"), {"user_id": "api-user"})
        self.assertEqual(after.json()["balance"], 100)

        detail = self.client.get(reverse("billing:order-detail", args=[body["id"]]))
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["status"], "paid")

    def test_unknown_user_balance_is_zero(self):
        response = self.client.get(reverse("billing:balance"), {"user_id": "nobody"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"user_id": "nobody", "balance": 0})

    def test_invalid_json_and_missing_user_id(self):
        invalid = self.client.post(
            reverse("billing:order-create"),
            data="{",
            content_type="application/json",
        )
        self.assertEqual(invalid.status_code, 400)
        missing = self.client.get(reverse("billing:balance"))
        self.assertEqual(missing.status_code, 400)
        missing_order = self.client.get(reverse("billing:order-detail", args=[99999]))
        self.assertEqual(missing_order.status_code, 404)


class AdminTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.starter = Package.objects.get(name="入门包")
        get_user_model().objects.create_superuser(
            "admin", "admin@example.com", "admin-pass-123"
        )

    def setUp(self):
        self.client.login(username="admin", password="admin-pass-123")

    def test_action_confirms_payment_once(self):
        order = create_order("admin-user", self.starter.id)
        url = reverse("admin:billing_order_changelist")
        payload = {"action": "confirm_payment", "_selected_action": [str(order.pk)]}
        self.client.post(url, payload)
        self.client.post(url, payload)

        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.PAID)
        self.assertEqual(get_balance("admin-user"), 100)
        self.assertEqual(LedgerEntry.objects.filter(user_id="admin-user").count(), 1)

    def test_dropdown_pay_keeps_original_snapshot(self):
        order = create_order("admin-user", self.starter.id)
        self.starter.credits = 5
        self.starter.price_cents = 50
        self.starter.save(update_fields=["credits", "price_cents"])

        response = self.client.post(
            reverse("admin:billing_order_change", args=[order.pk]),
            {
                "user_id": order.user_id,
                "package": order.package_id,
                "status": "paid",
            },
        )
        self.assertEqual(response.status_code, 302)

        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.PAID)
        self.assertEqual(order.credits, 100)
        self.assertEqual(order.price_cents, 1000)
        self.assertEqual(get_balance("admin-user"), 100)

    def test_add_order_already_paid(self):
        response = self.client.post(
            reverse("admin:billing_order_add"),
            {
                "user_id": "new-user",
                "package": self.starter.id,
                "status": "paid",
            },
        )
        self.assertEqual(response.status_code, 302)
        order = Order.objects.get(user_id="new-user")
        self.assertEqual(order.status, Order.Status.PAID)
        self.assertEqual(order.credits, 100)
        self.assertEqual(order.price_cents, 1000)
        self.assertEqual(get_balance("new-user"), 100)

    def test_confirm_payment_skips_closed_order(self):
        order = create_order("admin-user", self.starter.id)
        close_order(order.pk)
        self.client.post(
            reverse("admin:billing_order_changelist"),
            {"action": "confirm_payment", "_selected_action": [str(order.pk)]},
        )
        self.assertEqual(get_balance("admin-user"), 0)
        self.assertEqual(LedgerEntry.objects.count(), 0)


class ChargeTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.starter = Package.objects.get(name="入门包")

    def pay(self, user_id="user-1"):
        order = create_order(user_id, self.starter.id)
        mark_order_paid(order.pk)
        return order

    def test_charge_reduces_balance_and_records_debit(self):
        self.pay()
        entry, deducted = charge("user-1", "req-1")

        self.assertTrue(deducted)
        self.assertEqual(entry.kind, LedgerEntry.Kind.DEBIT)
        self.assertEqual(entry.credits, 1)
        self.assertEqual(entry.balance_after, 99)
        self.assertIsNone(entry.order_id)
        self.assertEqual(get_balance("user-1"), 99)
        self.assertEqual(
            list(
                LedgerEntry.objects.filter(user_id="user-1")
                .order_by("id")
                .values_list("kind", "credits", "balance_after")
            ),
            [
                (LedgerEntry.Kind.CREDIT, 100, 100),
                (LedgerEntry.Kind.DEBIT, 1, 99),
            ],
        )

    def test_same_request_id_charges_once(self):
        self.pay()
        charge("user-1", "req-1")
        entry, deducted = charge("user-1", "req-1")

        self.assertFalse(deducted)
        self.assertEqual(entry.balance_after, 99)
        self.assertEqual(get_balance("user-1"), 99)
        self.assertEqual(
            LedgerEntry.objects.filter(user_id="user-1", kind=LedgerEntry.Kind.DEBIT).count(),
            1,
        )

    def test_second_request_charges_again(self):
        self.pay()
        charge("user-1", "req-1")
        _, deducted = charge("user-1", "req-2")

        self.assertTrue(deducted)
        self.assertEqual(get_balance("user-1"), 98)

    def test_insufficient_balance_rejects_without_ledger(self):
        with self.assertRaises(BillingError) as raised:
            charge("user-1", "req-1")
        self.assertEqual(raised.exception.status, 402)
        self.assertFalse(UserAccount.objects.filter(user_id="user-1").exists())
        self.assertEqual(LedgerEntry.objects.count(), 0)
        self.assertEqual(get_balance("user-1"), 0)

        self.pay()
        for index in range(100):
            _, deducted = charge("user-1", f"spend-{index}")
            self.assertTrue(deducted)
        self.assertEqual(get_balance("user-1"), 0)
        with self.assertRaises(BillingError) as empty:
            charge("user-1", "spend-extra")
        self.assertEqual(empty.exception.status, 402)
        self.assertEqual(get_balance("user-1"), 0)
        self.assertEqual(
            LedgerEntry.objects.filter(user_id="user-1", kind=LedgerEntry.Kind.DEBIT).count(),
            100,
        )

    def test_request_id_cannot_be_reused_by_another_user(self):
        self.pay("user-1")
        self.pay("user-2")
        charge("user-1", "shared-req")

        with self.assertRaises(BillingError) as raised:
            charge("user-2", "shared-req")
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(get_balance("user-1"), 99)
        self.assertEqual(get_balance("user-2"), 100)
        self.assertEqual(LedgerEntry.objects.filter(request_id="shared-req").count(), 1)

    def test_blank_request_id_rejected(self):
        self.pay()
        with self.assertRaises(BillingError):
            charge("user-1", "   ")
        self.assertEqual(get_balance("user-1"), 100)

    def test_api_charges_once_and_reports_replay(self):
        self.pay("api-user")
        url = reverse("billing:charge-create")
        body = json.dumps({"user_id": "api-user", "request_id": "api-req"})
        first = self.client.post(url, data=body, content_type="application/json")
        self.assertEqual(first.status_code, 201)
        self.assertEqual(
            first.json(),
            {
                "user_id": "api-user",
                "request_id": "api-req",
                "kind": "debit",
                "kind_label": "扣费",
                "credits": 1,
                "balance_after": 99,
                "balance": 99,
                "deducted": True,
            },
        )

        second = self.client.post(url, data=body, content_type="application/json")
        self.assertEqual(second.status_code, 200)
        self.assertFalse(second.json()["deducted"])
        self.assertEqual(second.json()["balance"], 99)
        self.assertEqual(second.json()["balance_after"], 99)

        missing = self.client.post(
            url,
            data=json.dumps({"user_id": "api-user"}),
            content_type="application/json",
        )
        self.assertEqual(missing.status_code, 400)
        broke = self.client.post(
            url,
            data=json.dumps({"user_id": "nobody", "request_id": "no-money"}),
            content_type="application/json",
        )
        self.assertEqual(broke.status_code, 402)
        self.assertEqual(broke.json()["error"], "额度不足")


PASSWORD = "Shop-Pass-2026"


class AccountTests(TestCase):
    def test_home_requires_login(self):
        response = self.client.get(reverse("home"))
        self.assertRedirects(response, f"{reverse('login')}?next=/")

    def test_order_requires_login(self):
        starter = Package.objects.get(name="入门包")
        response = self.client.post(reverse("place-order"), {"package_id": starter.id})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].startswith(reverse("login")))
        self.assertFalse(Order.objects.exists())

    def test_register_logs_in(self):
        response = self.client.post(
            reverse("register"),
            {"username": "new-buyer", "password1": PASSWORD, "password2": PASSWORD},
            follow=True,
        )
        self.assertRedirects(response, reverse("home"))
        self.assertContains(response, "new-buyer")
        self.assertContains(response, 'id="balance">0<')
        user = get_user_model().objects.get(username="new-buyer")
        self.assertNotEqual(user.password, PASSWORD)
        self.assertTrue(user.check_password(PASSWORD))

    def test_register_rejects_mismatched_and_long_names(self):
        mismatch = self.client.post(
            reverse("register"),
            {"username": "buyer", "password1": PASSWORD, "password2": PASSWORD + "x"},
        )
        self.assertEqual(mismatch.status_code, 200)
        self.assertContains(mismatch, "field-error")
        too_long = self.client.post(
            reverse("register"),
            {"username": "x" * 65, "password1": PASSWORD, "password2": PASSWORD},
        )
        self.assertContains(too_long, "用户名不能超过 64 个字符")
        self.assertFalse(get_user_model().objects.exists())

    def test_register_rejects_taken_name(self):
        get_user_model().objects.create_user("buyer", password=PASSWORD)
        response = self.client.post(
            reverse("register"),
            {"username": "Buyer", "password1": PASSWORD, "password2": PASSWORD},
        )
        self.assertContains(response, "field-error")
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_login_and_logout(self):
        get_user_model().objects.create_user("buyer", password=PASSWORD)
        wrong = self.client.post(
            reverse("login"), {"username": "buyer", "password": "nope"}
        )
        self.assertContains(wrong, "用户名或密码不正确")

        ok = self.client.post(
            reverse("login"), {"username": "buyer", "password": PASSWORD}, follow=True
        )
        self.assertRedirects(ok, reverse("home"))
        self.assertContains(ok, "退出登录")
        self.assertRedirects(self.client.get(reverse("login")), reverse("home"))

        out = self.client.post(reverse("logout"), follow=True)
        self.assertRedirects(out, reverse("login"))
        self.assertRedirects(
            self.client.get(reverse("home")), f"{reverse('login')}?next=/"
        )


class UserPageTests(TestCase):
    def setUp(self):
        get_user_model().objects.create_user("page-user", password=PASSWORD)
        self.client.login(username="page-user", password=PASSWORD)

    def test_user_can_place_order_and_see_balance_after_payment(self):
        starter = Package.objects.get(name="入门包")
        entered = self.client.get(reverse("home"))
        self.assertContains(entered, "入门包")
        self.assertContains(entered, "10.00 元")
        self.assertContains(entered, "600 额度")
        self.assertContains(entered, 'id="balance">0<')
        self.assertContains(entered, "还没有订单")

        pending = self.client.post(
            reverse("place-order"),
            {"user_id": "someone-else", "package_id": starter.id},
            follow=True,
        )
        order = Order.objects.get()
        self.assertRedirects(pending, reverse("checkout", args=[order.order_no]))
        self.assertContains(pending, "微信扫码支付")
        home = self.client.get(reverse("home"))
        self.assertContains(home, "待支付")
        self.assertContains(home, "去支付")
        self.assertContains(home, 'id="balance">0<')

        self.assertEqual(order.user_id, "page-user")
        self.assertEqual(order.status, Order.Status.PENDING)
        self.assertEqual(order.credits, 100)
        mark_order_paid(order.pk)

        paid = self.client.get(reverse("home"))
        self.assertContains(paid, "已支付")
        self.assertContains(paid, 'id="balance">100<')
        self.assertContains(paid, "未配置 New API，暂时不能发放 key")

    def test_query_user_id_cannot_show_other_accounts(self):
        starter = Package.objects.get(name="入门包")
        other = create_order("other-user", starter.id)
        other.api_key = "sk-other-key"
        other.save(update_fields=["api_key"])
        response = self.client.get(reverse("home"), {"user_id": "other-user"})
        self.assertContains(response, "page-user")
        self.assertNotContains(response, "sk-other-key")
        self.assertNotContains(response, other.order_no)

    @override_settings(NEWAPI_BASE_URL="http://new-api.test")
    def test_paid_order_shows_issued_api_key(self):
        starter = Package.objects.get(name="入门包")
        order = create_order("page-user", starter.id)
        calls = []

        def fake_issue(paid):
            calls.append(paid.pk)
            paid.api_key = "sk-test-key"
            paid.api_key_error = ""
            paid.save(update_fields=["api_key", "api_key_error"])

        with patch("billing.services.issue_key", fake_issue):
            mark_order_paid(order.pk)

        page = self.client.get(reverse("home"))
        self.assertContains(page, "sk-test-key")
        self.assertContains(page, "http://127.0.0.1:3000/v1")
        self.assertEqual(get_balance("page-user"), 100)

        with patch("billing.services.issue_key", fake_issue):
            mark_order_paid(order.pk)
        self.assertEqual(calls, [order.pk])

    def test_inactive_package_is_hidden(self):
        starter = Package.objects.get(name="入门包")
        starter.is_active = False
        starter.save(update_fields=["is_active"])
        response = self.client.get(reverse("home"))
        self.assertNotContains(response, "入门包")
        self.assertContains(response, "标准包")


class FakeMerchantProvider(PaymentProvider):
    code = "fake_merchant"
    label = "测试商户"

    def checkout(self, order):
        return Checkout(qr_image_url="/fake-qr.png", needs_buyer_claim=False)

    def parse_notify(self, request):
        data = json.loads(request.body)
        return PaymentNotice(
            order_no=data["order_no"],
            amount_cents=data["amount_cents"],
            payment_ref=data["payment_ref"],
        )


class CheckoutTests(TestCase):
    def setUp(self):
        users = get_user_model().objects
        users.create_user("buyer", password=PASSWORD)
        users.create_user("other", password=PASSWORD)
        self.client.login(username="buyer", password=PASSWORD)
        self.starter = Package.objects.get(name="入门包")

    def place(self):
        self.client.post(reverse("place-order"), {"package_id": self.starter.id})
        return Order.objects.latest("id")

    def test_new_order_uses_manual_qr(self):
        order = self.place()
        self.assertEqual(order.payment_method, "manual_qr")
        page = self.client.get(reverse("checkout", args=[order.order_no]))
        self.assertContains(page, reverse("payment-qr"))
        self.assertContains(page, "¥10.00")
        self.assertContains(page, order.remark_code)
        self.assertContains(page, "我已完成支付")

    def test_claim_then_admin_confirm_shows_success(self):
        order = self.place()
        status_url = reverse("order-status", args=[order.order_no])
        self.assertEqual(
            self.client.get(status_url).json(), {"status": "pending", "claimed": False}
        )

        claimed = self.client.post(
            reverse("claim-payment", args=[order.order_no]), follow=True
        )
        self.assertContains(claimed, "正在确认收款")
        self.assertContains(claimed, "待确认")
        self.assertEqual(
            self.client.get(status_url).json(), {"status": "pending", "claimed": True}
        )
        order.refresh_from_db()
        first_claim = order.payer_claimed_at
        self.assertIsNotNone(first_claim)
        self.assertEqual(get_balance("buyer"), 0)

        self.client.post(reverse("claim-payment", args=[order.order_no]))
        order.refresh_from_db()
        self.assertEqual(order.payer_claimed_at, first_claim)

        mark_order_paid(order.pk)
        self.assertEqual(self.client.get(status_url).json()["status"], "paid")
        done = self.client.get(reverse("checkout", args=[order.order_no]))
        self.assertContains(done, "支付成功")
        self.assertContains(done, "100 额度已到账")
        self.assertEqual(get_balance("buyer"), 100)

    def test_cancel_order(self):
        order = self.place()
        cancelled = self.client.post(
            reverse("cancel-order", args=[order.order_no]), follow=True
        )
        self.assertContains(cancelled, "订单已取消")
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.CLOSED)
        claim = self.client.post(
            reverse("claim-payment", args=[order.order_no]), follow=True
        )
        self.assertContains(claim, "订单已取消")
        order.refresh_from_db()
        self.assertIsNone(order.payer_claimed_at)

    def test_other_user_cannot_touch_order(self):
        order = self.place()
        self.client.logout()
        self.client.login(username="other", password=PASSWORD)
        for name in ("checkout", "order-status"):
            self.assertEqual(
                self.client.get(reverse(name, args=[order.order_no])).status_code, 404
            )
        for name in ("claim-payment", "cancel-order"):
            self.assertEqual(
                self.client.post(reverse(name, args=[order.order_no])).status_code, 404
            )
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.PENDING)
        self.assertIsNone(order.payer_claimed_at)

    def test_payment_qr_needs_login_and_file(self):
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / "qr.jpg"
            image.write_bytes(b"\xff\xd8fake")
            with override_settings(PAYMENT_QR_IMAGE=image):
                served = self.client.get(reverse("payment-qr"))
                self.assertEqual(served.status_code, 200)
                self.assertEqual(b"".join(served.streaming_content), b"\xff\xd8fake")
                self.client.logout()
                self.assertEqual(self.client.get(reverse("payment-qr")).status_code, 302)
            self.client.login(username="buyer", password=PASSWORD)
            with override_settings(PAYMENT_QR_IMAGE=Path(folder) / "missing.jpg"):
                self.assertEqual(self.client.get(reverse("payment-qr")).status_code, 404)


@patch.dict(PROVIDERS, {FakeMerchantProvider.code: FakeMerchantProvider()})
class PaymentNotifyTests(TestCase):
    def setUp(self):
        self.order = create_order("buyer", Package.objects.get(name="入门包").id)

    def notify(self, code="fake_merchant", **overrides):
        body = {
            "order_no": self.order.order_no,
            "amount_cents": self.order.price_cents,
            "payment_ref": "wx-001",
        }
        body.update(overrides)
        return self.client.post(
            reverse("billing:payment-notify", args=[code]),
            data=json.dumps(body),
            content_type="application/json",
        )

    def test_manual_qr_and_unknown_provider_have_no_notify(self):
        self.assertEqual(self.notify("manual_qr").status_code, 400)
        self.assertEqual(self.notify("nope").status_code, 404)
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, Order.Status.PENDING)

    def test_wrong_amount_is_rejected(self):
        response = self.notify(amount_cents=1)
        self.assertEqual(response.status_code, 409)
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, Order.Status.PENDING)
        self.assertEqual(get_balance("buyer"), 0)

    def test_notify_pays_once(self):
        first = self.notify()
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.content, b"success")
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, Order.Status.PAID)
        self.assertEqual(self.order.payment_method, "fake_merchant")
        self.assertEqual(self.order.payment_ref, "wx-001")

        self.assertEqual(self.notify().status_code, 200)
        self.assertEqual(get_balance("buyer"), 100)
        self.assertEqual(LedgerEntry.objects.filter(order=self.order).count(), 1)
        self.assertEqual(self.notify(payment_ref="wx-002").status_code, 409)

    def test_payment_ref_cannot_pay_two_orders(self):
        self.assertEqual(self.notify().status_code, 200)
        second = create_order("buyer", Package.objects.get(name="入门包").id)
        response = self.notify(order_no=second.order_no)
        self.assertEqual(response.status_code, 409)
        second.refresh_from_db()
        self.assertEqual(second.status, Order.Status.PENDING)
        self.assertEqual(get_balance("buyer"), 100)
