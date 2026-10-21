from django import forms
from django.contrib.auth.forms import AuthenticationForm, UserCreationForm
from django.contrib.auth.models import User

USERNAME_MAX_LENGTH = 64


class SignInForm(AuthenticationForm):
    error_messages = {
        "invalid_login": "用户名或密码不正确。",
        "inactive": "这个账号已停用。",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["username"].widget.attrs.update(
            {"autocomplete": "username", "autofocus": True}
        )
        self.fields["password"].widget.attrs.update(
            {"autocomplete": "current-password"}
        )


class SignUpForm(UserCreationForm):
    class Meta:
        model = User
        fields = ("username",)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        username = self.fields["username"]
        username.max_length = USERNAME_MAX_LENGTH
        username.widget.attrs.update(
            {
                "autocomplete": "username",
                "autofocus": True,
                "maxlength": USERNAME_MAX_LENGTH,
            }
        )
        username.help_text = "最多 64 个字符，可用字母、数字和 @ . + - _"
        self.fields["password1"].widget.attrs.update({"autocomplete": "new-password"})
        self.fields["password2"].widget.attrs.update({"autocomplete": "new-password"})
        self.fields["password1"].help_text = "至少 8 位，不能只有数字，也不能太常见。"
        self.fields["password2"].help_text = ""

    def clean_username(self):
        username = super().clean_username()
        if username and len(username) > USERNAME_MAX_LENGTH:
            raise forms.ValidationError("用户名不能超过 64 个字符。")
        return username
