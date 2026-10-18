import json
from collections import deque

import resend
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.authz import enforce_policy
from app.database import get_db
from app.deps import get_current_user
from app.event_log import EventLogger
from app.event_snapshots import court_dict
from app.models import Booking, Court, User
from app.schemas import (
    BookingReminderRequest,
    EmailNotificationRequest,
    Message,
    TransferOwnershipRequest,
)

router = APIRouter(prefix="/api/dashboard")
event_logger = EventLogger()
settings = get_settings()


def _manager_only(user: User) -> None:
    if user.role not in {"moderator", "admin", "superuser"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role"
        )


@router.get("/moderator-messages", response_model=list[dict])
def list_moderator_messages(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[dict]:
    _manager_only(user)
    messages = deque(maxlen=100)
    with event_logger.path.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            event = json.loads(line)
            if event["event_type"] != "moderator.message_sent":
                continue
            author = db.get(User, event["actor_id"])
            if author is None:
                continue
            messages.append({
                "id": event["event_id"],
                "created_at": event["created_at"],
                "author_name": author.full_name,
                "subject": event["payload"]["subject"],
                "message": event["payload"]["message"],
            })
    return list(reversed(messages))


@router.post("/courts/{court_id}/transfer-ownership", response_model=Message)
def transfer_ownership(
    court_id: str,
    payload: TransferOwnershipRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Message:
    court = db.get(Court, court_id)
    if court is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Court not found"
        )
    enforce_policy(db, user, "/courts/:courtId", "update", owner_id=court.owner_id)
    new_owner = db.scalar(select(User).where(User.email == payload.new_owner_email))
    # Anti-enumeration behavior: generic success even if account does not exist.
    if new_owner:
        court.owner_id = new_owner.id
        db.commit()
        db.refresh(court)
        event_logger.append(
            "court.transfer_ownership",
            user.id,
            {
                "court": court_dict(court),
                "new_owner_id": new_owner.id,
                "target_email": payload.new_owner_email,
            },
        )
    else:
        event_logger.append(
            "court.transfer_ownership",
            user.id,
            {
                "court_id": court_id,
                "target_email": payload.new_owner_email,
                "applied": False,
            },
        )
    return Message(message="Transfer request accepted.")


@router.post("/notifications/email", response_model=Message)
def send_email_notifications(
    payload: EmailNotificationRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Message:
    enforce_policy(db, user, "/dashboard/notifications/email", "create")
    # Placeholder dispatch; intended to be integrated with Resend provider.
    event_logger.append("notifications.email_dispatched", user.id, payload.model_dump())
    return Message(message="Notification campaign queued.")


@router.get("/bookings", response_model=list[dict])
def list_dashboard_bookings(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[dict]:
    _manager_only(user)
    enforce_policy(db, user, "/dashboard/bookings", "read")
    bookings = list(db.scalars(select(Booking).order_by(Booking.starts_at.desc())))
    return [
        {
            "id": b.id,
            "court_id": b.court_id,
            "court_name": b.court.name if b.court else b.court_id,
            "user_id": b.user_id,
            "user_email": b.user.email if b.user else "",
            "status": b.status,
            "starts_at": b.starts_at,
            "ends_at": b.ends_at,
            "total_price": b.total_price,
        }
        for b in bookings
    ]


@router.post("/bookings/{booking_id}/remind", response_model=Message)
def remind_booking_user(
    booking_id: str,
    payload: BookingReminderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Message:
    _manager_only(user)
    enforce_policy(db, user, "/dashboard/bookings/:bookingId/remind", "create")
    booking = db.get(Booking, booking_id)
    if booking is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found"
        )
    if booking.user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Booking user not found"
        )
    if not settings.resend_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email provider is not configured",
        )
    resend.api_key = settings.resend_api_key
    comment = (payload.comment or "").strip()
    comment_text = (
        comment if comment else "Just a friendly reminder about your booking."
    )
    court_name = booking.court.name if booking.court else booking.court_id
    starts_at = booking.starts_at.isoformat()
    ends_at = booking.ends_at.isoformat()
    resend.Emails.send(
        {
            "from": "noreply@courtly.click",
            "to": [booking.user.email],
            "subject": "Courtly booking reminder",
            "html": (
                "<h2>Booking reminder</h2>"
                "<p>This is a reminder about your upcoming tennis booking.</p>"
                f"<p><strong>Booking ID:</strong> {booking.id}</p>"
                f"<p><strong>Court:</strong> {court_name}</p>"
                f"<p><strong>Starts at:</strong> {starts_at}</p>"
                f"<p><strong>Ends at:</strong> {ends_at}</p>"
                f"<p><strong>Message from moderator:</strong> {comment_text}</p>"
                "<p>See you on court,<br/>Courtly Team</p>"
            ),
            "text": (
                "Booking reminder\n\n"
                "This is a reminder about your upcoming tennis booking.\n"
                f"Booking ID: {booking.id}\n"
                f"Court: {court_name}\n"
                f"Starts at: {starts_at}\n"
                f"Ends at: {ends_at}\n"
                f"Message from moderator: {comment_text}\n\n"
                "See you on court,\nCourtly Team"
            ),
        }
    )
    event_logger.append(
        "booking.reminder_sent",
        user.id,
        {
            "booking_id": booking.id,
            "target_user_id": booking.user_id,
            "target_email": booking.user.email,
            "comment": comment,
        },
    )
    return Message(message="Reminder sent.")
