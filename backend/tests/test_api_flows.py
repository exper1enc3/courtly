from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app


def _auth_headers(client: TestClient) -> dict[str, str]:
    login = client.post(
        "/api/auth/login",
        json={"email": "superuser@courtly.example.com", "password": "ChangeMeNow123!"},
    )
    assert login.status_code == 200, login.text
    body = login.json()
    if body.get("mfa_required"):
        verify = client.post(
            "/api/auth/verify-2fa",
            json={
                "challenge_token": body["mfa_challenge_token"],
                "code": body["mfa_dev_code"],
            },
        )
        assert verify.status_code == 200, verify.text
        token = verify.json()["access_token"]
    else:
        token = body["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_health() -> None:
    with TestClient(app) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"


def test_seeded_courts_and_availability_support_ui() -> None:
    with TestClient(app) as client:
        courts = client.get("/api/courts")
        assert courts.status_code == 200
        body = courts.json()
        assert len(body) >= 3

        availability = client.get(f"/api/courts/{body[0]['id']}/availability")
        assert availability.status_code == 200
        assert availability.json()[0]["state"] in {
            "free",
            "held",
            "booked",
            "disabled",
            "past",
        }
        assert any(slot["state"] == "disabled" for slot in availability.json())


def test_public_register_requires_email_verification() -> None:
    unique = uuid4().hex[:8]
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            json={
                "first_name": "Vasya",
                "last_name": "Pupkin",
                "email": f"vasya-{unique}@courtly.example.com",
                "password": "ChangeMeNow123!",
            },
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["email_verification_required"] is True
        assert body["email_verification_challenge_token"]
        assert body["email_verification_dev_code"]

        verify = client.post(
            "/api/auth/verify-email",
            json={
                "challenge_token": body["email_verification_challenge_token"],
                "code": body["email_verification_dev_code"],
            },
        )
        assert verify.status_code == 200, verify.text

        token = verify.json()["access_token"]
        profile = client.get(
            "/api/me/profile", headers={"Authorization": f"Bearer {token}"}
        )
        assert profile.status_code == 200, profile.text
        assert profile.json()["full_name"] == "Pupkin Vasya"
        assert profile.json()["email_verified"] is True


def test_register_rejects_weak_password() -> None:
    unique = uuid4().hex[:8]
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            json={
                "first_name": "Weak",
                "last_name": "Password",
                "email": f"weak-{unique}@courtly.example.com",
                "password": "password",
            },
        )
        assert response.status_code == 422, response.text
        assert "Password must be at least 8 characters" in response.text


def test_superuser_login_requires_mfa() -> None:
    with TestClient(app) as client:
        login = client.post(
            "/api/auth/login",
            json={
                "email": "superuser@courtly.example.com",
                "password": "ChangeMeNow123!",
            },
        )
        assert login.status_code == 200, login.text
        body = login.json()
        assert body["mfa_required"] is True
        assert body["mfa_challenge_token"]
        assert body["mfa_dev_code"]

        verify = client.post(
            "/api/auth/verify-2fa",
            json={
                "challenge_token": body["mfa_challenge_token"],
                "code": body["mfa_dev_code"],
            },
        )
        assert verify.status_code == 200, verify.text
        assert verify.json()["access_token"]


def test_core_flow_create_court_hold_confirm_cancel() -> None:
    with TestClient(app) as client:
        headers = _auth_headers(client)
        create_court = client.post(
            "/api/courts",
            headers=headers,
            json={
                "name": "Center Court",
                "city": "Kyiv",
                "district": "Pechersk",
                "address": "Main Street 1",
                "surface": "clay",
                "price_per_hour": 800,
                "opening_time": "00:00",
                "closing_time": "23:59",
            },
        )
        assert create_court.status_code == 201, create_court.text
        court_id = create_court.json()["id"]

        base = datetime.now(timezone.utc) + timedelta(hours=2)
        base = base.replace(minute=(base.minute // 30) * 30, second=0, microsecond=0)
        slots = [base.isoformat(), (base + timedelta(minutes=30)).isoformat()]
        hold = client.post(
            "/api/bookings/hold",
            headers=headers,
            json={"court_id": court_id, "slot_starts": slots},
        )
        assert hold.status_code == 201, hold.text
        hold_token = hold.json()["hold_token"]

        confirm = client.post(
            "/api/bookings/confirm", headers=headers, json={"hold_token": hold_token}
        )
        assert confirm.status_code == 200, confirm.text
        booking_id = confirm.json()["id"]
        assert confirm.json()["status"] == "confirmed"

        cancel = client.post(
            f"/api/bookings/{booking_id}/cancel",
            headers=headers,
            json={"reason": "Cannot attend"},
        )
        assert cancel.status_code == 200, cancel.text
        assert cancel.json()["status"] == "cancelled"

        detail = client.get(f"/api/me/bookings/{booking_id}", headers=headers)
        assert detail.status_code == 200, detail.text
        assert detail.json()["court_name"] == "Center Court"

        review = client.post(
            "/api/me/reviews",
            headers=headers,
            json={
                "booking_id": booking_id,
                "court_id": court_id,
                "rating": 5,
                "comment": "Great court",
            },
        )
        assert review.status_code == 201, review.text
        assert review.json()["author_email"] == "superuser@courtly.example.com"
        for path in ("/api/me/reviews", f"/api/me/reviews/public/{court_id}"):
            reviews = client.get(path, headers=headers)
            assert reviews.status_code == 200, reviews.text
            saved = next(row for row in reviews.json() if row["id"] == review.json()["id"])
            assert saved["author_email"] == "superuser@courtly.example.com"
        detail = client.get(f"/api/me/bookings/{booking_id}", headers=headers).json()
        assert detail["reviews"][0]["author_email"] == "superuser@courtly.example.com"
        assert detail["my_review"]["author_email"] == "superuser@courtly.example.com"
        duplicate_review = client.post(
            "/api/me/reviews",
            headers=headers,
            json={
                "booking_id": booking_id,
                "court_id": court_id,
                "rating": 4,
                "comment": "Duplicate",
            },
        )
        assert duplicate_review.status_code == 409, duplicate_review.text

        moderator_message = client.post(
            "/api/me/moderator-message",
            headers=headers,
            json={
                "booking_id": booking_id,
                "court_id": court_id,
                "subject": "Question",
                "message": "Please confirm lights are available.",
            },
        )
        assert moderator_message.status_code == 200, moderator_message.text


def test_moderator_inbox_preserves_payload_and_requires_manager() -> None:
    from app.database import SessionLocal
    from app.models import User
    from app.security import create_token

    with TestClient(app) as client:
        headers = _auth_headers(client)
        subject = f"XSS demo {uuid4().hex}"
        payload = "<script>alert('XSS demo')</script>"
        response = client.post(
            "/api/me/moderator-message",
            headers=headers,
            json={"subject": subject, "message": payload},
        )
        assert response.status_code == 200, response.text
        inbox = client.get("/api/dashboard/moderator-messages", headers=headers)
        assert inbox.status_code == 200, inbox.text
        assert inbox.json()[0]["subject"] == subject
        assert inbox.json()[0]["message"] == payload
        assert client.get("/api/dashboard/moderator-messages").status_code == 401

        with SessionLocal() as db:
            user = User(
                email=f"inbox-{uuid4().hex}@example.com",
                full_name="Inbox user",
                password_hash="unused",
                role="user",
            )
            db.add(user)
            db.commit()
            token = create_token(str(user.id), "access", 5, extra={"uid": user.id})
            user_headers = {"Authorization": f"Bearer {token}"}
            assert client.get("/api/dashboard/moderator-messages", headers=user_headers).status_code == 403
            user.role = "moderator"
            db.commit()
            assert client.get("/api/dashboard/moderator-messages", headers=user_headers).status_code == 200


def test_admin_dashboard_crud_endpoints_support_ui() -> None:
    unique = uuid4().hex[:8]
    with TestClient(app) as client:
        headers = _auth_headers(client)

        users = client.get("/api/admin/users", headers=headers)
        roles = client.get("/api/admin/roles", headers=headers)
        policies = client.get("/api/admin/policies", headers=headers)
        bookings = client.get("/api/admin/bookings", headers=headers)
        assert users.status_code == 200
        assert roles.status_code == 200
        assert policies.status_code == 200
        assert bookings.status_code == 200

        created_user = client.post(
            "/api/admin/users",
            headers=headers,
            json={
                "email": f"manager-{unique}@courtly.example.com",
                "full_name": "Dashboard Manager",
                "password": "ChangeMeNow123!",
                "role": "user",
            },
        )
        assert created_user.status_code == 201, created_user.text
        user_id = created_user.json()["id"]

        updated_user = client.patch(
            f"/api/admin/users/{user_id}", headers=headers, json={"role": "moderator"}
        )
        assert updated_user.status_code == 200, updated_user.text
        assert updated_user.json()["role"] == "moderator"

        created_role = client.post(
            "/api/admin/roles", headers=headers, json={"name": f"ops_{unique}"}
        )
        assert created_role.status_code == 201, created_role.text
        role_id = created_role.json()["id"]

        created_policy = client.post(
            "/api/admin/policies",
            headers=headers,
            json={
                "role": "admin",
                "resource": "/courts",
                "action": f"tune_{unique}",
                "effect": "allow",
                "condition": "",
            },
        )
        assert created_policy.status_code == 201, created_policy.text
        policy_id = created_policy.json()["id"]

        updated_policy = client.patch(
            f"/api/admin/policies/{policy_id}",
            headers=headers,
            json={
                "role": "admin",
                "resource": "/courts",
                "action": f"tune_{unique}",
                "effect": "deny",
                "condition": "maintenance",
            },
        )
        assert updated_policy.status_code == 200, updated_policy.text
        assert updated_policy.json()["effect"] == "deny"

        created_court = client.post(
            "/api/courts",
            headers=headers,
            json={
                "name": f"Admin Court {unique}",
                "city": "Kyiv",
                "district": "Pechersk",
                "address": "Dashboard 1",
                "surface": "Hard",
                "price_per_hour": 777,
                "opening_time": "09:00",
                "closing_time": "20:00",
            },
        )
        assert created_court.status_code == 201, created_court.text
        court_id = created_court.json()["id"]

        updated_court = client.patch(
            f"/api/courts/{court_id}",
            headers=headers,
            json={
                "price_per_hour": 888,
                "opening_time": "08:00",
                "closing_time": "21:00",
            },
        )
        assert updated_court.status_code == 200, updated_court.text
        assert updated_court.json()["price_per_hour"] == 888
        assert updated_court.json()["opening_time"] == "08:00"

        assert (
            client.delete(f"/api/courts/{court_id}", headers=headers).status_code == 200
        )
        assert (
            client.delete(
                f"/api/admin/policies/{policy_id}", headers=headers
            ).status_code
            == 200
        )
        assert (
            client.delete(f"/api/admin/roles/{role_id}", headers=headers).status_code
            == 200
        )
        assert (
            client.delete(f"/api/admin/users/{user_id}", headers=headers).status_code
            == 200
        )


def test_gdpr_data_deletion_request_lifecycle() -> None:
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select

    from app.database import SessionLocal
    from app.models import DataDeletionRequest, User

    unique = uuid4().hex[:8]
    with TestClient(app) as client:
        admin_headers = _auth_headers(client)

        register = client.post(
            "/api/auth/register",
            json={
                "first_name": "Eraz",
                "last_name": f"User{unique}",
                "email": f"eraz-{unique}@courtly.example.com",
                "password": "ChangeMeNow123!",
            },
        )
        assert register.status_code == 201, register.text
        user_token = register.json()["access_token"]
        user_headers = {"Authorization": f"Bearer {user_token}"}

        empty = client.get("/api/me/profile/data-deletion-status", headers=user_headers)
        assert empty.status_code == 200
        assert empty.json() is None

        created = client.post(
            "/api/me/profile/request-data-deletion",
            headers=user_headers,
            json={"reason": "Closing my account"},
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert body["status"] == "pending"
        request_id = body["id"]
        target_user_id = body["user_id"]
        assert body["seconds_remaining"] > 13 * 24 * 3600
        assert body["deadline_days_total"] == 14

        duplicate = client.post(
            "/api/me/profile/request-data-deletion", headers=user_headers, json={}
        )
        assert duplicate.status_code == 200
        assert duplicate.json()["id"] == request_id

        admin_list = client.get(
            "/api/admin/data-deletion-requests", headers=admin_headers
        )
        assert admin_list.status_code == 200, admin_list.text
        ids = [row["id"] for row in admin_list.json()]
        assert request_id in ids

        withdrawn = client.delete(
            "/api/me/profile/data-deletion-request", headers=user_headers
        )
        assert withdrawn.status_code == 200

        status_after = client.get(
            "/api/me/profile/data-deletion-status", headers=user_headers
        )
        assert status_after.status_code == 200
        assert status_after.json() is None

        second = client.post(
            "/api/me/profile/request-data-deletion", headers=user_headers, json={}
        )
        assert second.status_code == 200
        second_id = second.json()["id"]
        assert second_id != request_id

        approved = client.post(
            f"/api/admin/data-deletion-requests/{second_id}/approve",
            headers=admin_headers,
            json={"note": "Verified identity"},
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "approved_executed"

        db = SessionLocal()
        try:
            assert db.get(User, target_user_id) is None
        finally:
            db.close()

        third_register = client.post(
            "/api/auth/register",
            json={
                "first_name": "Sla",
                "last_name": f"Lapse{unique}",
                "email": f"sla-{unique}@courtly.example.com",
                "password": "ChangeMeNow123!",
            },
        )
        assert third_register.status_code == 201
        third_headers = {
            "Authorization": f"Bearer {third_register.json()['access_token']}"
        }
        third = client.post(
            "/api/me/profile/request-data-deletion", headers=third_headers, json={}
        )
        third_id = third.json()["id"]
        third_user_id = third.json()["user_id"]

        db = SessionLocal()
        try:
            request = db.get(DataDeletionRequest, third_id)
            request.deadline_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            db.commit()
        finally:
            db.close()

        admin_list_after = client.get(
            "/api/admin/data-deletion-requests?status_filter=all", headers=admin_headers
        )
        assert admin_list_after.status_code == 200
        statuses = {row["id"]: row["status"] for row in admin_list_after.json()}
        assert statuses[third_id] == "expired_executed"

        db = SessionLocal()
        try:
            assert db.get(User, third_user_id) is None
        finally:
            db.close()


def test_superuser_account_cannot_be_deleted_via_admin_or_gdpr() -> None:
    with TestClient(app) as client:
        admin_headers = _auth_headers(client)

        me = client.get("/api/me/profile", headers=admin_headers)
        assert me.status_code == 200
        superuser_id = me.json()["id"]
        assert me.json()["role"] == "superuser"

        self_delete = client.delete(
            f"/api/admin/users/{superuser_id}", headers=admin_headers
        )
        assert self_delete.status_code == 403, self_delete.text

        gdpr_request = client.post(
            "/api/me/profile/request-data-deletion",
            headers=admin_headers,
            json={"reason": "Should be rejected"},
        )
        assert gdpr_request.status_code == 403, gdpr_request.text

        users = client.get("/api/admin/users", headers=admin_headers).json()
        emails = [user["full_name"] for user in users]
        assert any("Superuser" in name for name in emails)
