import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.models import User
from app.routers import auth


@pytest.mark.parametrize("email_verified", [False, True])
def test_default_admin_demo_code_in_production(monkeypatch, email_verified):
    with TestClient(app) as client:
        monkeypatch.setattr(auth.settings, "app_env", "prod")

        def unexpected_email(*args):
            pytest.fail("Default admin demo must not send email")

        monkeypatch.setattr(auth, "_send_mfa_code", unexpected_email)
        monkeypatch.setattr(auth, "_send_email_verification_code", unexpected_email)
        with SessionLocal() as db:
            user = db.scalar(select(User).where(User.email == auth.settings.superuser_email))
            original_verified = user.email_verified
            user.email_verified = email_verified
            db.commit()

        try:
            login = client.post("/api/auth/login", json={
                "email": auth.settings.superuser_email,
                "password": auth.settings.superuser_password,
            })
            assert login.status_code == 200, login.text
            kind = "mfa" if email_verified else "email_verification"
            assert login.json()[f"{kind}_dev_code"] == "123456"
            challenge = login.json()[f"{kind}_challenge_token"]
            endpoint = "/api/auth/verify-2fa" if email_verified else "/api/auth/verify-email"
            wrong = client.post(endpoint, json={"challenge_token": challenge, "code": "000000"})
            assert wrong.status_code == 401
            invalid = client.post(endpoint, json={"challenge_token": "invalid", "code": "123456"})
            assert invalid.status_code == 401
            verified = client.post(endpoint, json={"challenge_token": challenge, "code": "123456"})
            assert verified.status_code == 200, verified.text
            assert verified.json()["access_token"]
        finally:
            with SessionLocal() as db:
                user = db.scalar(select(User).where(User.email == auth.settings.superuser_email))
                user.email_verified = original_verified
                db.commit()


def test_demo_code_is_scoped_to_default_admin():
    assert not auth._uses_admin_demo_code(User(email="other@example.com", role="admin"))
    assert not auth._uses_admin_demo_code(User(email=auth.settings.superuser_email, role="user"))
