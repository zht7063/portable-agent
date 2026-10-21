from django.urls import path

from . import pages

urlpatterns = [
    path("", pages.home, name="home"),
    path("orders/", pages.place_order, name="place-order"),
]
