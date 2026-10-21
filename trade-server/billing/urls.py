from django.urls import path

from . import views

app_name = "billing"

urlpatterns = [
    path("packages/", views.package_list, name="package-list"),
    path("orders/", views.order_create, name="order-create"),
    path("orders/<int:order_id>/", views.order_detail, name="order-detail"),
    path("balance/", views.balance, name="balance"),
    path("charges/", views.charge_create, name="charge-create"),
]
