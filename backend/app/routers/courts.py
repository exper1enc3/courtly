from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.authz import enforce_policy
from app.config import get_settings
from app.database import get_db
from app.deps import get_current_user
from app.event_log import EventLogger
from app.event_snapshots import court_dict
from app.models import Booking, Court, Review, User
from app.schemas import AvailabilitySlot, CourtCreate, CourtResponse, CourtUpdate

router = APIRouter(prefix="/api/courts")
event_logger = EventLogger()
court_upload_dir = get_settings().uploads_dir / "courts"


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _minutes(value: str) -> int:
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def _inside_working_hours(court: Court, starts_at: datetime, ends_at: datetime) -> bool:
    start_minutes = starts_at.hour * 60 + starts_at.minute
    end_minutes = ends_at.hour * 60 + ends_at.minute
    return start_minutes >= _minutes(court.opening_time) and end_minutes <= _minutes(court.closing_time)


@router.get("", response_model=list[CourtResponse])
def list_courts(
    city: str | None = None, district: str | None = None, db: Session = Depends(get_db)
) -> list[CourtResponse]:
    query = select(Court).where(Court.is_active.is_(True))
    if city:
        query = query.where(Court.city == city)
    if district:
        query = query.where(Court.district == district)
    courts = list(db.scalars(query))
    rating_rows = db.execute(
        select(Review.court_id, func.avg(Review.rating), func.count(Review.id)).group_by(Review.court_id)
    ).all()
    ratings = {court_id: (float(avg or 0), int(count or 0)) for court_id, avg, count in rating_rows}
    return [
        CourtResponse(
            id=court.id,
            name=court.name,
            city=court.city,
            district=court.district,
            address=court.address,
            surface=court.surface,
            price_per_hour=court.price_per_hour,
            opening_time=court.opening_time,
            closing_time=court.closing_time,
            image_url=court.image_url,
            latitude=court.latitude,
            longitude=court.longitude,
            owner_id=court.owner_id,
            is_active=court.is_active,
            rating_avg=round(ratings.get(court.id, (0, 0))[0], 2),
            review_count=ratings.get(court.id, (0, 0))[1],
        )
        for court in courts
    ]


@router.post("", response_model=CourtResponse, status_code=status.HTTP_201_CREATED)
def create_court(
    payload: CourtCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> CourtResponse:
    enforce_policy(db, user, "/courts", "create")
    owner_id = payload.owner_id or user.id
    court = Court(**payload.model_dump(exclude={"owner_id"}), owner_id=owner_id)
    db.add(court)
    db.commit()
    db.refresh(court)
    event_logger.append("court.created", user.id, {"court": court_dict(court)})
    return court


@router.get("/{court_id}", response_model=CourtResponse)
def get_court(court_id: str, db: Session = Depends(get_db)) -> CourtResponse:
    court = db.get(Court, court_id)
    if court is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Court not found")
    avg_rating, review_count = db.execute(
        select(func.avg(Review.rating), func.count(Review.id)).where(Review.court_id == court_id)
    ).one()
    return CourtResponse(
        id=court.id,
        name=court.name,
        city=court.city,
        district=court.district,
        address=court.address,
        surface=court.surface,
        price_per_hour=court.price_per_hour,
        opening_time=court.opening_time,
        closing_time=court.closing_time,
        image_url=court.image_url,
        latitude=court.latitude,
        longitude=court.longitude,
        owner_id=court.owner_id,
        is_active=court.is_active,
        rating_avg=round(float(avg_rating or 0), 2),
        review_count=int(review_count or 0),
    )


@router.patch("/{court_id}", response_model=CourtResponse)
def update_court(
    court_id: str, payload: CourtUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> CourtResponse:
    court = db.get(Court, court_id)
    if court is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Court not found")
    enforce_policy(db, user, "/courts/:courtId", "update", owner_id=court.owner_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(court, key, value)
    db.commit()
    db.refresh(court)
    event_logger.append("court.updated", user.id, {"court": court_dict(court)})
    return court


@router.delete("/{court_id}", response_model=dict[str, bool])
def delete_court(court_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict[str, bool]:
    court = db.get(Court, court_id)
    if court is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Court not found")
    enforce_policy(db, user, "/courts/:courtId", "delete", owner_id=court.owner_id)
    db.delete(court)
    db.commit()
    event_logger.append("court.deleted", user.id, {"court_id": court.id})
    return {"deleted": True}


@router.get("/{court_id}/availability", response_model=list[AvailabilitySlot])
def get_availability(
    court_id: str,
    start: datetime = Query(default_factory=lambda: datetime.now(timezone.utc)),
    days: int = 7,
    db: Session = Depends(get_db),
) -> list[AvailabilitySlot]:
    court = db.get(Court, court_id)
    if court is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Court not found")
    start = _naive(start)
    now = _naive(datetime.now(timezone.utc))
    window_end = start + timedelta(days=max(1, min(days, 7)))
    bookings = list(
        db.scalars(
            select(Booking).where(
                and_(Booking.court_id == court_id, Booking.starts_at < window_end, Booking.ends_at > start)
            )
        )
    )
    slots: list[AvailabilitySlot] = []
    cursor = start
    while cursor < window_end:
        slot_end = cursor + timedelta(minutes=30)
        state = "free"
        if slot_end <= now:
            state = "past"
        if not _inside_working_hours(court, cursor, slot_end):
            state = "disabled"
        for booking in bookings:
            if _naive(booking.starts_at) < slot_end and _naive(booking.ends_at) > cursor:
                state = "held" if booking.status == "draft_hold" else "booked"
                break
        slots.append(AvailabilitySlot(starts_at=cursor, ends_at=slot_end, state=state))
        cursor = slot_end
    return slots


@router.post("/{court_id}/image", response_model=dict[str, str])
async def upload_court_image(
    court_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    court = db.get(Court, court_id)
    if court is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Court not found")
    enforce_policy(db, user, "/courts/:courtId", "update", owner_id=court.owner_id)
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only image files are allowed")

    court_upload_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or "image").suffix or ".jpg"
    filename = f"{court_id}-{uuid4().hex}{ext}"
    target = court_upload_dir / filename
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Image must be < 10MB")
    target.write_bytes(content)

    court.image_url = f"/uploads/courts/{filename}"
    db.commit()
    db.refresh(court)
    event_logger.append("court.image_uploaded", user.id, {"court": court_dict(court)})
    return {"image_url": court.image_url}


@router.get("/{court_id}/bookings", response_model=list[dict])
def list_court_bookings(court_id: str, db: Session = Depends(get_db)) -> list[dict]:
    court = db.get(Court, court_id)
    if court is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Court not found")
    bookings = list(
        db.scalars(
            select(Booking)
            .where(Booking.court_id == court_id, Booking.status.in_(["confirmed", "active", "completed"]))
            .order_by(Booking.starts_at.desc())
            .limit(20)
        )
    )
    return [
        {
            "id": booking.id,
            "status": booking.status,
            "starts_at": booking.starts_at,
            "ends_at": booking.ends_at,
            "total_price": booking.total_price,
            "user_id": booking.user_id,
        }
        for booking in bookings
    ]
