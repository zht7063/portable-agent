import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse

from billing.models import LedgerEntry, Order, Package, UserAccount
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


class UserPageTests(TestCase):
    def test_home_asks_for_user_id(self):
        response = self.client.get(reverse("home"))
        self.assertContains(response, "用户标识")
        self.assertNotContains(response, "入门包")

    def test_user_can_place_order_and_see_balance_after_payment(self):
        starter = Package.objects.get(name="入门包")
        entered = self.client.get(reverse("home"), {"user_id": "page-user"})
        self.assertContains(entered, "入门包")
        self.assertContains(entered, "10.00 元")
        self.assertContains(entered, "600 额度")
        self.assertContains(entered, 'id="balance">0<')
        self.assertContains(entered, "还没有订单")

        pending = self.client.post(
            reverse("place-order"),
            {"user_id": "page-user", "package_id": starter.id},
            follow=True,
        )
        self.assertRedirects(pending, "/?user_id=page-user")
        self.assertContains(pending, "待支付")
        self.assertContains(pending, "等待确认收款后发放 API key")
        self.assertContains(pending, 'id="balance">0<')

        order = Order.objects.get(user_id="page-user")
        self.assertEqual(order.status, Order.Status.PENDING)
        self.assertEqual(order.credits, 100)
        mark_order_paid(order.pk)

        paid = self.client.get(reverse("home"), {"user_id": "page-user"})
        self.assertContains(paid, "已支付")
        self.assertContains(paid, 'id="balance">100<')
        self.assertContains(paid, "未配置 New API，暂时不能发放 key")

    @override_settings(NEWAPI_BASE_URL="http://new-api.test")
    def test_paid_order_shows_issued_api_key(self):
        starter = Package.objects.get(name="入门包")
        order = Order.objects.create(
            user_id="key-user",
            package=starter,
            package_name=starter.name,
            price_cents=starter.price_cents,
            credits=starter.credits,
        )

        calls = []

        def fake_issue(paid):
            calls.append(paid.pk)
            paid.api_key = "sk-test-key"
            paid.api_key_error = ""
            paid.save(update_fields=["api_key", "api_key_error"])

        with patch("billing.services.issue_key", fake_issue):
            mark_order_paid(order.pk)

        page = self.client.get(reverse("home"), {"user_id": "key-user"})
        self.assertContains(page, "sk-test-key")
        self.assertContains(page, "http://127.0.0.1:3000/v1")
        self.assertEqual(get_balance("key-user"), 100)

        with patch("billing.services.issue_key", fake_issue):
            mark_order_paid(order.pk)
        self.assertEqual(calls, [order.pk])

    def test_inactive_package_is_hidden(self):
        starter = Package.objects.get(name="入门包")
        starter.is_active = False
        starter.save(update_fields=["is_active"])
        response = self.client.get(reverse("home"), {"user_id": "page-user"})
        self.assertNotContains(response, "入门包")
        self.assertContains(response, "标准包")

    def test_long_user_id_is_rejected(self):
        response = self.client.get(reverse("home"), {"user_id": "x" * 65})
        self.assertContains(response, "user_id 不能超过 64 个字符")
        self.assertNotContains(response, "id=\"balance\"")
