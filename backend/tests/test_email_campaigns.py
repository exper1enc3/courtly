from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.deps import get_current_user
from app.main import app
from app.models import Policy, User
from app.routers import dashboard


@pytest.fixture
def campaign_app(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        admin = User(email="admin@example.com", full_name="Адмін", role="admin", password_hash="unused")
        olena = User(email="olena@example.com", full_name="Олена Коваленко", role="user", password_hash="unused")
        inactive = User(email="andrii@example.com", full_name="Андрій Мельник", role="user", password_hash="unused", is_active=False)
        db.add_all([admin, olena, inactive, Policy(role="admin", resource="/dashboard/notifications/email", action="create", effect="allow")])
        db.commit()
        app.dependency_overrides[get_db] = lambda: db
        app.dependency_overrides[get_current_user] = lambda: admin
        monkeypatch.setattr(dashboard.settings, "resend_api_key", "test-key")
        monkeypatch.setattr(dashboard, "sleep", lambda _: None)
        batches = []
        events = []

        def send(messages):
            batches.append(messages)
            return {"data": [{"id": f"email-{i}"} for i in range(len(messages))]}

        monkeypatch.setattr(dashboard.resend.Batch, "send", send)
        monkeypatch.setattr(dashboard.event_logger, "append", lambda *args: events.append(args))
        try:
            with TestClient(app) as client:
                yield SimpleNamespace(client=client, db=db, admin=admin, olena=olena, inactive=inactive, batches=batches, events=events)
        finally:
            app.dependency_overrides.clear()
    engine.dispose()


def send_campaign(ctx, **changes):
    return ctx.client.post("/api/dashboard/notifications/email", json={
        "subject": "Вітаємо, {{name}}!", "body": "Привіт, {{ name }}!\n<b>До зустрічі!</b>", **changes
    })


def test_campaign_personalizes_each_recipient_and_excludes_inactive(campaign_app):
    ctx = campaign_app
    response = send_campaign(ctx)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert response.json()["recipient_count"] == response.json()["accepted_count"] == 2
    messages = ctx.batches[0]
    assert len(messages) == 2
    assert messages[1]["to"] == ["olena@example.com"]
    assert messages[1]["subject"] == "Вітаємо, Олена Коваленко!"
    assert messages[1]["text"] == "Привіт, Олена Коваленко!\n<b>До зустрічі!</b>"
    assert "html" not in messages[1]
    assert all(len(message["to"]) == 1 and "cc" not in message and "bcc" not in message for message in messages)
    assert ctx.events[0][0] == "notifications.email_dispatched"


def test_all_users_includes_inactive(campaign_app):
    response = send_campaign(campaign_app, recipient_scope="all_users")
    assert response.status_code == 200
    assert response.json()["accepted_count"] == 3


def test_custom_segment_targets_only_selected_users_and_deduplicates(campaign_app):
    ctx = campaign_app
    response = send_campaign(ctx, recipient_scope="custom_segment", recipient_ids=[ctx.olena.id, ctx.olena.id])
    assert response.status_code == 200
    assert response.json()["accepted_count"] == 1
    assert ctx.batches[0][0]["to"] == [ctx.olena.email]


@pytest.mark.parametrize("role", ["user", "moderator"])
def test_non_admin_cannot_send_campaign(campaign_app, role):
    ctx = campaign_app
    ctx.admin.role = role
    response = send_campaign(ctx)
    assert response.status_code == 403
    assert not ctx.batches


def test_campaign_requires_authentication(campaign_app):
    app.dependency_overrides.pop(get_current_user)
    assert send_campaign(campaign_app).status_code == 401
    assert not campaign_app.batches


def test_inactive_admin_cannot_send(campaign_app):
    campaign_app.admin.is_active = False
    assert send_campaign(campaign_app).status_code == 403
    assert not campaign_app.batches


def test_admin_policy_is_enforced(campaign_app):
    campaign_app.db.query(Policy).delete()
    campaign_app.db.commit()
    assert send_campaign(campaign_app).status_code == 403
    assert not campaign_app.batches


def test_superuser_can_send_without_explicit_policy(campaign_app):
    campaign_app.admin.role = "superuser"
    assert send_campaign(campaign_app).json()["status"] == "completed"


def test_campaign_requires_configured_provider(campaign_app, monkeypatch):
    monkeypatch.setattr(dashboard.settings, "resend_api_key", "")
    assert send_campaign(campaign_app).status_code == 503
    assert not campaign_app.batches


@pytest.mark.parametrize("changes, expected", [
    ({"subject": "   "}, 422),
    ({"body": "\n "}, 422),
    ({"subject": "x" * 201}, 422),
    ({"recipient_scope": "custom_segment", "recipient_ids": []}, 400),
    ({"recipient_scope": "custom_segment", "recipient_ids": [999999]}, 400),
])
def test_invalid_campaign_is_not_sent(campaign_app, changes, expected):
    assert send_campaign(campaign_app, **changes).status_code == expected
    assert not campaign_app.batches


def test_provider_failure_is_reported_without_automatic_retry(campaign_app, monkeypatch):
    ctx = campaign_app
    ctx.db.add_all([User(email=f"user{i}@example.com", full_name=f"User {i}", role="user", password_hash="unused") for i in range(100)])
    ctx.db.commit()
    calls = []

    def send(messages):
        calls.append(messages)
        if len(calls) == 2:
            raise TimeoutError("provider unavailable")
        return {"data": [{"id": str(i)} for i in range(len(messages))]}

    monkeypatch.setattr(dashboard.resend.Batch, "send", send)
    response = send_campaign(ctx)
    assert response.status_code == 200
    assert response.json()["status"] == "partial"
    assert response.json()["recipient_count"] == 102
    assert response.json()["accepted_count"] == 100
    assert [len(batch) for batch in calls] == [100, 2]
    assert ctx.events[0][0] == "notifications.email_dispatch_incomplete"


def test_total_provider_failure_is_not_reported_as_success(campaign_app, monkeypatch):
    def fail(messages):
        raise TimeoutError("provider unavailable")

    monkeypatch.setattr(dashboard.resend.Batch, "send", fail)
    response = send_campaign(campaign_app)
    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert response.json()["accepted_count"] == 0
