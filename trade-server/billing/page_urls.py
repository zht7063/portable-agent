from django.contrib.auth.views import LogoutView
from django.urls import path

from . import pages

urlpatterns = [
    path("", pages.home, name="home"),
    path("orders/", pages.place_order, name="place-order"),
    path("pay/qr/", pages.payment_qr, name="payment-qr"),
    path("pay/<str:order_no>/", pages.checkout, name="checkout"),
    path("pay/<str:order_no>/claim/", pages.claim_order_payment, name="claim-payment"),
    path("pay/<str:order_no>/cancel/", pages.cancel_order, name="cancel-order"),
    path("pay/<str:order_no>/status/", pages.order_status, name="order-status"),
    path("login/", pages.SignInView.as_view(), name="login"),
    path("register/", pages.sign_up, name="register"),
    path("logout/", LogoutView.as_view(), name="logout"),
]
