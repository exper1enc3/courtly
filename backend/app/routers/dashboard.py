import json
import logging
import re
from collections import deque
from time import sleep

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
    EmailNotificationResponse,
    Message,
    TransferOwnershipRequest,
)

router = APIRouter(prefix="/api/dashboard")
event_logger = EventLogger()
settings = get_settings()
logger = logging.getLogger(__name__)


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


def _personalize_campaign(template: str, recipient: User) -> str:
    return re.sub(r"\{\{\s*name\s*\}\}", lambda _: recipient.full_name, template)


@router.post("/notifications/email", response_model=EmailNotificationResponse)
def send_email_notifications(
    payload: EmailNotificationRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> EmailNotificationResponse:
    if user.role not in {"admin", "superuser"} or not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role")
    enforce_policy(db, user, "/dashboard/notifications/email", "create")
    query = select(User).order_by(User.id)
    if payload.recipient_scope == "active_users":
        query = query.where(User.is_active.is_(True))
    elif payload.recipient_scope == "custom_segment":
        if not payload.recipient_ids:
            raise HTTPException(status_code=400, detail="Select at least one recipient")
        query = query.where(User.id.in_(payload.recipient_ids))
    recipients = list(db.scalars(query))
    if payload.recipient_scope == "custom_segment" and len(recipients) != len(set(payload.recipient_ids)):
        raise HTTPException(status_code=400, detail="Some selected users no longer exist")
    if not recipients:
        raise HTTPException(status_code=400, detail="No recipients match this audience")
    if not settings.resend_api_key:
        raise HTTPException(status_code=503, detail="Email provider is not configured")

    resend.api_key = settings.resend_api_key
    accepted_count = 0
    for offset in range(0, len(recipients), 100):
        if offset:
            sleep(0.6)
        batch = recipients[offset:offset + 100]
        messages = [
            {
                "from": "Courtly <noreply@courtly.click>",
                "to": [recipient.email],
                "subject": _personalize_campaign(payload.subject, recipient),
                "text": _personalize_campaign(payload.body, recipient),
            }
            for recipient in batch
        ]
        try:
            response = resend.Batch.send(messages)
            accepted_count += len(response["data"])
            if len(response["data"]) != len(batch):
                break
        except Exception as exc:
            # A timeout may happen after acceptance: never retry automatically.
            logger.warning("Campaign batch at offset %d failed: %s", offset, type(exc).__name__)
            break

    complete = accepted_count == len(recipients)
    result = EmailNotificationResponse(
        message="Campaign accepted by email provider." if complete else "Email provider did not confirm the entire campaign. Do not retry blindly: some messages may already have been accepted.",
        recipient_count=len(recipients),
        accepted_count=accepted_count,
        status="completed" if complete else "partial" if accepted_count else "failed",
    )
    event_logger.append(
        "notifications.email_dispatched" if complete else "notifications.email_dispatch_incomplete",
        user.id,
        {**payload.model_dump(), **result.model_dump(), "recipient_ids": [recipient.id for recipient in recipients]},
    )
    return result


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
