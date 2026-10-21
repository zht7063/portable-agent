from django.db import migrations


PACKAGES = [
    {"name": "入门包", "price_cents": 1000, "credits": 100, "sort_order": 1},
    {"name": "标准包", "price_cents": 5000, "credits": 600, "sort_order": 2},
    {"name": "进阶包", "price_cents": 10000, "credits": 1500, "sort_order": 3},
]


def seed_packages(apps, schema_editor):
    Package = apps.get_model("billing", "Package")
    for row in PACKAGES:
        Package.objects.update_or_create(
            name=row["name"],
            defaults={
                "price_cents": row["price_cents"],
                "credits": row["credits"],
                "sort_order": row["sort_order"],
                "is_active": True,
            },
        )


def unseed_packages(apps, schema_editor):
    Package = apps.get_model("billing", "Package")
    Package.objects.filter(name__in=[row["name"] for row in PACKAGES]).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("billing", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_packages, unseed_packages),
    ]
