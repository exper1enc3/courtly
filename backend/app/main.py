from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import Base, SessionLocal, engine
from app.gdpr import sweep_expired
from app.models import Court, Permission, Policy, Role, User
from app.routers import api_router
from app.security import hash_password

settings = get_settings()
app = FastAPI(title=settings.app_name)
uploads_dir = settings.uploads_dir
uploads_dir.mkdir(parents=True, exist_ok=True)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/uploads", StaticFiles(directory=str(uploads_dir)), name="uploads")


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_schema()
    _seed_defaults()
    _sweep_gdpr_on_startup()


def _ensure_schema() -> None:
    with engine.begin() as connection:
        user_columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(users)"))
        }
        if "mfa_enabled" not in user_columns:
            connection.execute(
                text(
                    "ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN DEFAULT 0 NOT NULL"
                )
            )
        if "email_verified" not in user_columns:
            connection.execute(
                text(
                    "ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT 0 NOT NULL"
                )
            )
        columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(courts)"))
        }
        if "opening_time" not in columns:
            connection.execute(
                text(
                    "ALTER TABLE courts ADD COLUMN opening_time VARCHAR(5) DEFAULT '07:00' NOT NULL"
                )
            )
        if "closing_time" not in columns:
            connection.execute(
                text(
                    "ALTER TABLE courts ADD COLUMN closing_time VARCHAR(5) DEFAULT '22:00' NOT NULL"
                )
            )
        if "image_url" not in columns:
            connection.execute(
                text("ALTER TABLE courts ADD COLUMN image_url VARCHAR(600)")
            )
        review_columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(reviews)"))
        }
        if "booking_id" not in review_columns:
            connection.execute(
                text("ALTER TABLE reviews ADD COLUMN booking_id VARCHAR(36)")
            )
        existing_indexes = {
            row[1] for row in connection.execute(text("PRAGMA index_list(reviews)"))
        }
        if "uq_review_user_booking" not in existing_indexes:
            connection.execute(
                text(
                    "CREATE UNIQUE INDEX uq_review_user_booking ON reviews(user_id, booking_id)"
                )
            )
        policy_columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(policies)"))
        }
        if "role" not in policy_columns:
            connection.execute(
                text(
                    "ALTER TABLE policies ADD COLUMN role VARCHAR(60) DEFAULT 'admin' NOT NULL"
                )
            )


def _sweep_gdpr_on_startup() -> None:
    db: Session = SessionLocal()
    try:
        sweep_expired(db)
    finally:
        db.close()


def _seed_rbac_policies(db: Session) -> None:
    """Roles, permissions, and default policies (no users or courts). Used on DB restore from event log."""
    for role_name in ["guest", "user", "moderator", "admin", "superuser"]:
        if db.scalar(select(Role).where(Role.name == role_name)) is None:
            db.add(Role(name=role_name))
    defaults = [
        "courts:create",
        "courts:update",
        "courts:delete",
        "bookings:hold",
        "bookings:confirm",
        "bookings:cancel",
        "notifications:send_email",
        "event_log:replay",
    ]
    for permission in defaults:
        if db.scalar(select(Permission).where(Permission.name == permission)) is None:
            db.add(Permission(name=permission))
    default_policies = [
        ("moderator", "/courts", "read", "allow", "ownership:all"),
        ("moderator", "/courts/:courtId", "read", "allow", "ownership:all"),
        (
            "moderator",
            "/courts/:courtId/availability",
            "read",
            "allow",
            "ownership:all",
        ),
        ("moderator", "/me/bookings", "read", "allow", "ownership:self"),
        ("moderator", "/me/bookings/:bookingId", "read", "allow", "ownership:self"),
        ("moderator", "/me/profile", "read", "allow", "ownership:self"),
        ("moderator", "/me/profile", "update", "allow", "ownership:self"),
        ("moderator", "/me/favorites", "read", "allow", "ownership:self"),
        ("moderator", "/me/favorites", "create", "allow", "ownership:self"),
        ("moderator", "/me/favorites/:courtId", "delete", "allow", "ownership:self"),
        ("moderator", "/me/reviews", "create", "allow", "ownership:self"),
        ("moderator", "/me/reviews/public/:courtId", "read", "allow", "ownership:all"),
        ("moderator", "/me/moderator-message", "create", "allow", "ownership:self"),
        ("admin", "/courts", "read", "allow", "ownership:all"),
        ("admin", "/courts/:courtId", "read", "allow", "ownership:all"),
        ("admin", "/courts/:courtId/availability", "read", "allow", "ownership:all"),
        ("admin", "/me/bookings", "read", "allow", "ownership:self"),
        ("admin", "/me/bookings/:bookingId", "read", "allow", "ownership:self"),
        ("admin", "/me/profile", "read", "allow", "ownership:self"),
        ("admin", "/me/profile", "update", "allow", "ownership:self"),
        ("admin", "/me/favorites", "read", "allow", "ownership:self"),
        ("admin", "/me/favorites", "create", "allow", "ownership:self"),
        ("admin", "/me/favorites/:courtId", "delete", "allow", "ownership:self"),
        ("admin", "/me/reviews", "create", "allow", "ownership:self"),
        ("admin", "/me/reviews/public/:courtId", "read", "allow", "ownership:all"),
        ("admin", "/me/moderator-message", "create", "allow", "ownership:self"),
        ("user", "/courts", "read", "allow", "ownership:all"),
        ("user", "/courts/:courtId", "read", "allow", "ownership:all"),
        ("user", "/courts/:courtId/availability", "read", "allow", "ownership:all"),
        ("user", "/bookings/hold", "create", "allow", "ownership:self"),
        ("user", "/bookings/confirm", "create", "allow", "ownership:self"),
        ("user", "/bookings/:bookingId/cancel", "create", "allow", "ownership:self"),
        ("user", "/me/bookings", "read", "allow", "ownership:self"),
        ("user", "/me/bookings/:bookingId", "read", "allow", "ownership:self"),
        ("user", "/me/profile", "read", "allow", "ownership:self"),
        ("user", "/me/profile", "update", "allow", "ownership:self"),
        (
            "user",
            "/me/profile/request-data-deletion",
            "create",
            "allow",
            "ownership:self",
        ),
        ("user", "/me/favorites", "read", "allow", "ownership:self"),
        ("user", "/me/favorites", "create", "allow", "ownership:self"),
        ("user", "/me/favorites/:courtId", "delete", "allow", "ownership:self"),
        ("user", "/me/reviews", "create", "allow", "ownership:self"),
        ("user", "/me/reviews/public/:courtId", "read", "allow", "ownership:all"),
        ("user", "/me/moderator-message", "create", "allow", "ownership:self"),
        ("moderator", "/courts", "create", "allow", "ownership:all"),
        ("moderator", "/courts/:courtId", "update", "allow", "ownership:self"),
        ("moderator", "/courts/:courtId", "delete", "allow", "ownership:self"),
        ("moderator", "/dashboard/bookings", "read", "allow", "ownership:all"),
        (
            "moderator",
            "/dashboard/bookings/:bookingId/remind",
            "create",
            "allow",
            "ownership:all",
        ),
        ("admin", "/admin/users", "read", "allow", "ownership:all"),
        ("admin", "/admin/users", "create", "allow", "ownership:all"),
        ("admin", "/admin/users/:userId", "update", "allow", "ownership:all"),
        ("admin", "/admin/users/:userId", "delete", "allow", "ownership:all"),
        ("admin", "/admin/roles", "read", "allow", "ownership:all"),
        ("admin", "/admin/roles", "create", "allow", "ownership:all"),
        ("admin", "/admin/roles/:roleId", "delete", "allow", "ownership:all"),
        ("admin", "/admin/policies", "read", "allow", "ownership:all"),
        ("admin", "/admin/policies", "create", "allow", "ownership:all"),
        ("admin", "/admin/policies/:policyId", "update", "allow", "ownership:all"),
        ("admin", "/admin/policies/:policyId", "delete", "allow", "ownership:all"),
        ("admin", "/admin/bookings", "read", "allow", "ownership:all"),
        ("admin", "/dashboard/notifications/email", "create", "allow", "ownership:all"),
        ("admin", "/dashboard/bookings", "read", "allow", "ownership:all"),
        (
            "admin",
            "/dashboard/bookings/:bookingId/remind",
            "create",
            "allow",
            "ownership:all",
        ),
        ("admin", "/admin/event-log/replay", "create", "allow", "ownership:all"),
        ("admin", "/admin/data-deletion-requests", "read", "allow", "ownership:all"),
        (
            "admin",
            "/admin/data-deletion-requests/:requestId",
            "update",
            "allow",
            "ownership:all",
        ),
    ]
    for role, resource, action, effect, condition in default_policies:
        existing_policy = db.scalar(
            select(Policy).where(
                Policy.role == role,
                Policy.resource == resource,
                Policy.action == action,
            )
        )
        if existing_policy is None:
            db.add(
                Policy(
                    role=role,
                    resource=resource,
                    action=action,
                    effect=effect,
                    condition=condition,
                )
            )


def _seed_defaults() -> None:
    db: Session = SessionLocal()
    try:
        superuser = db.scalar(
            select(User).where(User.email == settings.superuser_email)
        )
        if superuser is None:
            superuser = User(
                email=settings.superuser_email,
                full_name="System Superuser",
                password_hash=hash_password(settings.superuser_password),
                role="superuser",
                must_change_password=True,
                mfa_enabled=True,
                email_verified=True,
            )
            db.add(superuser)
            db.flush()
        elif not superuser.email_verified:
            superuser.email_verified = True
        _seed_rbac_policies(db)
        sample_courts = [
            {
                "name": "Center Court Pechersk",
                "city": "Kyiv",
                "district": "Pechersk",
                "address": "Main Street 1",
                "surface": "Clay",
                "price_per_hour": 800,
                "opening_time": "07:00",
                "closing_time": "22:00",
                "image_url": "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=1200&q=80",
                "latitude": "50.436",
                "longitude": "30.538",
            },
            {
                "name": "Riverside Tennis Club",
                "city": "Kyiv",
                "district": "Podil",
                "address": "Naberezhna 24",
                "surface": "Hard",
                "price_per_hour": 650,
                "opening_time": "06:30",
                "closing_time": "23:00",
                "image_url": "https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?auto=format&fit=crop&w=1200&q=80",
                "latitude": "50.468",
                "longitude": "30.515",
            },
            {
                "name": "Urban Rally Arena",
                "city": "Kyiv",
                "district": "Obolon",
                "address": "Sportyvna 8",
                "surface": "Hard",
                "price_per_hour": 720,
                "opening_time": "08:00",
                "closing_time": "21:30",
                "image_url": "https://images.unsplash.com/photo-1628900973605-4200f0f1a723?auto=format&fit=crop&w=1200&q=80",
                "latitude": "50.505",
                "longitude": "30.498",
            },
        ]
        for court_data in sample_courts:
            if db.scalar(select(Court).where(Court.name == court_data["name"])) is None:
                db.add(Court(**court_data, owner_id=superuser.id))
        db.commit()
    finally:
        db.close()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(api_router())
