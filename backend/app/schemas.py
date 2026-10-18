from datetime import datetime
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


PASSWORD_POLICY_MESSAGE = "Password must be at least 8 characters and include uppercase, lowercase, digit, and special character."


def _validate_password_policy(password: str) -> str:
    if len(password) < 8:
        raise ValueError(PASSWORD_POLICY_MESSAGE)
    if not re.search(r"[A-Z]", password):
        raise ValueError(PASSWORD_POLICY_MESSAGE)
    if not re.search(r"[a-z]", password):
        raise ValueError(PASSWORD_POLICY_MESSAGE)
    if not re.search(r"\d", password):
        raise ValueError(PASSWORD_POLICY_MESSAGE)
    if not re.search(r"[^A-Za-z0-9]", password):
        raise ValueError(PASSWORD_POLICY_MESSAGE)
    return password


class Message(BaseModel):
    message: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    access_token: str | None = None
    refresh_token: str | None = None
    token_type: str = "bearer"
    must_change_password: bool = False
    mfa_required: bool = False
    mfa_challenge_token: str | None = None
    mfa_dev_code: str | None = None
    email_verification_required: bool = False
    email_verification_challenge_token: str | None = None
    email_verification_dev_code: str | None = None


class RegisterRequest(BaseModel):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8)

    _password_policy = field_validator("password")(_validate_password_policy)


class RefreshRequest(BaseModel):
    refresh_token: str


class VerifyMfaRequest(BaseModel):
    challenge_token: str
    code: str = Field(min_length=6, max_length=6)


class VerifyEmailRequest(BaseModel):
    challenge_token: str
    code: str = Field(min_length=6, max_length=6)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    must_change_password: bool = False


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8)

    _new_password_policy = field_validator("new_password")(_validate_password_policy)


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(min_length=8)

    _new_password_policy = field_validator("new_password")(_validate_password_policy)


class CourtBase(BaseModel):
    name: str
    city: str
    district: str
    address: str
    surface: str
    price_per_hour: int = Field(ge=0)
    opening_time: str = "07:00"
    closing_time: str = "22:00"
    image_url: str | None = None
    latitude: str | None = None
    longitude: str | None = None


class CourtCreate(CourtBase):
    owner_id: int | None = None


class CourtUpdate(BaseModel):
    name: str | None = None
    city: str | None = None
    district: str | None = None
    address: str | None = None
    surface: str | None = None
    price_per_hour: int | None = Field(default=None, ge=0)
    opening_time: str | None = None
    closing_time: str | None = None
    image_url: str | None = None
    is_active: bool | None = None


class CourtResponse(CourtBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    owner_id: int
    is_active: bool
    rating_avg: float = 0
    review_count: int = 0


class AvailabilitySlot(BaseModel):
    starts_at: datetime
    ends_at: datetime
    state: Literal["free", "held", "booked", "disabled", "past"]


class BookingHoldRequest(BaseModel):
    court_id: str
    slot_starts: list[datetime] = Field(min_length=2)


class BookingConfirmRequest(BaseModel):
    hold_token: str


class BookingCancelRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class BookingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    court_id: str
    user_id: int
    status: str
    hold_token: str | None = None
    held_until: datetime | None = None
    starts_at: datetime
    ends_at: datetime
    total_price: int
    canceled_reason: str | None = None


class BookingHoldResponse(BookingResponse):
    pass


class ProfileSelf(BaseModel):
    id: int
    email: EmailStr
    full_name: str
    role: str
    phone: str | None = None
    mfa_enabled: bool = False
    email_verified: bool = False


class ProfileUpdateRequest(BaseModel):
    full_name: str | None = None
    phone: str | None = None


class MfaPreferenceUpdateRequest(BaseModel):
    enabled: bool


class FavoriteRequest(BaseModel):
    court_id: str


class FavoriteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    court_id: str


class ReviewCreateRequest(BaseModel):
    booking_id: str
    court_id: str
    rating: int = Field(ge=1, le=5)
    comment: str


class ModeratorMessageRequest(BaseModel):
    booking_id: str | None = None
    court_id: str | None = None
    subject: str
    message: str = Field(min_length=3)


class ReviewUpdateRequest(BaseModel):
    rating: int | None = Field(default=None, ge=1, le=5)
    comment: str | None = None


class ReviewResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    author_email: str
    court_id: str
    booking_id: str | None = None
    rating: int
    comment: str
    created_at: datetime
    updated_at: datetime


class TransferOwnershipRequest(BaseModel):
    new_owner_email: EmailStr


class EmailNotificationRequest(BaseModel):
    subject: str
    body: str
    recipient_scope: Literal["all_users", "active_users", "custom_segment"] = (
        "active_users"
    )


class BookingReminderRequest(BaseModel):
    comment: str | None = Field(default=None, max_length=300)


class UserProjection(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    full_name: str
    role: str
    is_active: bool


class UserCreateRequest(BaseModel):
    email: EmailStr
    full_name: str
    password: str = Field(min_length=8)
    role: str = "user"
    phone: str | None = None

    _password_policy = field_validator("password")(_validate_password_policy)


class UserUpdateRequest(BaseModel):
    full_name: str | None = None
    role: str | None = None
    is_active: bool | None = None
    phone: str | None = None


class RoleCreateRequest(BaseModel):
    name: str


class RoleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str


class PermissionCreateRequest(BaseModel):
    name: str


class PermissionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str


class PolicyRequest(BaseModel):
    role: str
    resource: str
    action: str
    effect: Literal["allow", "deny"] = "allow"
    condition: str = ""


class PolicyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    resource: str
    action: str
    effect: str
    condition: str


class RoleBindingRequest(BaseModel):
    user_id: int
    role_id: int


class EventReplayResponse(BaseModel):
    ok: bool
    events_replayed: int


class DataDeletionRequestCreate(BaseModel):
    reason: str | None = Field(default=None, max_length=600)


class DataDeletionAdminAction(BaseModel):
    note: str | None = Field(default=None, max_length=600)


class DataDeletionRequestResponse(BaseModel):
    id: int
    user_id: int
    user_email: str
    user_full_name: str
    requested_at: datetime
    deadline_at: datetime
    status: str
    reason: str | None = None
    processed_at: datetime | None = None
    processed_by_user_id: int | None = None
    processed_note: str | None = None
    seconds_remaining: int
    deadline_days_total: int
