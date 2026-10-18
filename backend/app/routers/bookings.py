from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.authz import enforce_policy
from app.database import get_db
from app.deps import get_current_user
from app.event_log import EventLogger
from app.event_snapshots import booking_dict
from app.models import Booking, Court, User
from app.schemas import BookingCancelRequest, BookingConfirmRequest, BookingHoldRequest, BookingHoldResponse, BookingResponse, CheckoutResponse

router = APIRouter(prefix="/api/bookings")
event_logger = EventLogger()


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _validate_slots(slot_starts: list[datetime]) -> tuple[datetime, datetime]:
    ordered = sorted(slot_starts)
    if len(ordered) < 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Minimum booking length is 60 minutes")
    for i in range(1, len(ordered)):
        if ordered[i] - ordered[i - 1] != timedelta(minutes=30):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Slots must be contiguous 30-minute steps")
    return ordered[0], ordered[-1] + timedelta(minutes=30)


def _minutes(value: str) -> int:
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def _inside_working_hours(court: Court, starts_at: datetime, ends_at: datetime) -> bool:
    starts_at = _naive(starts_at)
    ends_at = _naive(ends_at)
    start_minutes = starts_at.hour * 60 + starts_at.minute
    end_minutes = ends_at.hour * 60 + ends_at.minute
    return start_minutes >= _minutes(court.opening_time) and end_minutes <= _minutes(court.closing_time)


def _has_conflict(
    db: Session, court_id: str, starts_at: datetime, ends_at: datetime, exclude_booking_id: str | None = None
) -> bool:
    query = select(Booking).where(
        and_(
            Booking.court_id == court_id,
            Booking.status.in_(["draft_hold", "confirmed", "active"]),
            Booking.starts_at < ends_at,
            Booking.ends_at > starts_at,
            or_(Booking.held_until.is_(None), Booking.held_until > _now()),
        )
    )
    if exclude_booking_id:
        query = query.where(Booking.id != exclude_booking_id)
    return db.scalar(query) is not None


@router.post("/hold", response_model=BookingHoldResponse, status_code=status.HTTP_201_CREATED)
def create_hold(
    payload: BookingHoldRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> BookingHoldResponse:
    enforce_policy(db, user, "/bookings/hold", "create", owner_id=user.id)
    court = db.get(Court, payload.court_id)
    if court is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Court not found")
    starts_at, ends_at = _validate_slots(payload.slot_starts)
    if not _inside_working_hours(court, starts_at, ends_at):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Court is closed for selected time")
    if _has_conflict(db, payload.court_id, starts_at, ends_at):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Slot conflict")
    total_minutes = int((ends_at - starts_at).total_seconds() // 60)
    total_price = int(court.price_per_hour * (total_minutes / 60))
    booking = Booking(
        court_id=payload.court_id,
        user_id=user.id,
        status="draft_hold",
        hold_token=token_urlsafe(24),
        held_until=datetime.now(timezone.utc) + timedelta(minutes=5),
        starts_at=starts_at,
        ends_at=ends_at,
        total_price=total_price,
    )
    db.add(booking)
    db.commit()
    db.refresh(booking)
    event_logger.append("booking.hold_created", user.id, {"booking": booking_dict(booking)})
    return booking


@router.post("/confirm", response_model=BookingResponse)
def confirm_hold(
    payload: BookingConfirmRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> BookingResponse:
    booking = db.scalar(select(Booking).where(Booking.hold_token == payload.hold_token))
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Hold not found")
    enforce_policy(db, user, "/bookings/confirm", "create", owner_id=booking.user_id)
    if booking.status != "draft_hold":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Hold is not confirmable")
    if booking.held_until is None or _naive(booking.held_until) < _now():
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Hold expired")
    if _has_conflict(db, booking.court_id, booking.starts_at, booking.ends_at, exclude_booking_id=booking.id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Booking conflict")
    booking.status = "confirmed"
    booking.hold_token = None
    booking.held_until = None
    db.commit()
    db.refresh(booking)
    event_logger.append("booking.confirmed", user.id, {"booking": booking_dict(booking)})
    return booking


@router.post("/checkout", response_model=CheckoutResponse)
def checkout(
    payload: BookingConfirmRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> CheckoutResponse:
    """Approve the demo payment and confirm the hold without charging money."""
    booking = confirm_hold(payload, user, db)
    return CheckoutResponse(booking=BookingResponse.model_validate(booking))


@router.post("/{booking_id}/cancel", response_model=BookingResponse)
def cancel_booking(
    booking_id: str,
    payload: BookingCancelRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BookingResponse:
    booking = db.get(Booking, booking_id)
    if booking is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")
    enforce_policy(db, user, "/bookings/:bookingId/cancel", "create", owner_id=booking.user_id)
    if booking.status in {"cancelled", "completed"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Booking cannot be canceled")
    booking.status = "cancelled"
    booking.canceled_reason = payload.reason
    booking.hold_token = None
    booking.held_until = None
    db.commit()
    db.refresh(booking)
    event_logger.append("booking.cancelled", user.id, {"booking": booking_dict(booking), "reason": payload.reason})
    return booking
