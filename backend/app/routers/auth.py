import hashlib
import secrets

import resend
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.deps import get_current_user
from app.event_log import EventLogger
from app.event_snapshots import user_dict
from app.models import User
from app.schemas import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginResponse,
    LoginRequest,
    Message,
    RegisterRequest,
    RefreshRequest,
    ResetPasswordRequest,
    TokenPair,
    VerifyEmailRequest,
    VerifyMfaRequest,
)
from app.security import create_token, decode_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth")
settings = get_settings()
event_logger = EventLogger()
DEFAULT_ADMIN_DEMO_CODE = "123456"


def _uses_admin_demo_code(user: User) -> bool:
    return (
        user.email == settings.superuser_email
        and user.role in {"admin", "superuser"}
    )


def _token_pair(user: User) -> TokenPair:
    access = create_token(
        str(user.id),
        "access",
        settings.access_token_minutes,
        extra={"uid": user.id, "role": user.role},
    )
    refresh = create_token(
        str(user.id),
        "refresh",
        settings.refresh_token_minutes,
        extra={"uid": user.id, "role": user.role},
    )
    return TokenPair(
        access_token=access,
        refresh_token=refresh,
        must_change_password=user.must_change_password,
    )


def _mfa_code_hash(user_id: int, code: str) -> str:
    return hashlib.sha256(
        f"{user_id}:{code}:{settings.jwt_secret}".encode("utf-8")
    ).hexdigest()


def _send_mfa_code(email: str, code: str) -> None:
    if not settings.resend_api_key:
        if settings.app_env in {"dev", "test"}:
            return
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA email provider is not configured",
        )
    resend.api_key = settings.resend_api_key
    resend.Emails.send(
        {
            "from": settings.mfa_from_email,
            "to": [email],
            "template": {
                "id": "security-verification",
                "variables": {
                    "CODE": int(code),
                    "minutes": str(settings.mfa_code_minutes),
                },
            },
        }
    )


def _send_email_verification_code(email: str, code: str) -> None:
    if not settings.resend_api_key:
        if settings.app_env in {"dev", "test"}:
            return
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email provider is not configured",
        )
    resend.api_key = settings.resend_api_key
    resend.Emails.send(
        {
            "from": settings.mfa_from_email,
            "to": [email],
            "subject": "Verify your Courtly account",
            "html": (
                "<p>Your verification code is "
                f"<strong>{code}</strong>. "
                "Enter it in the app to activate your account.</p>"
            ),
            "text": f"Your verification code is {code}. Enter it in the app to activate your account.",
        }
    )


def _issue_email_verification_challenge(user: User) -> LoginResponse:
    admin_demo = _uses_admin_demo_code(user)
    code = DEFAULT_ADMIN_DEMO_CODE if admin_demo else str(secrets.randbelow(900000) + 100000)
    code_hash = _mfa_code_hash(user.id, code)
    challenge = create_token(
        str(user.id),
        "email_verification",
        settings.mfa_code_minutes,
        extra={"uid": user.id, "code_hash": code_hash},
    )
    try:
        if not admin_demo:
            _send_email_verification_code(user.email, code)
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        detail = "Failed to send email verification code"
        if settings.app_env in {"dev", "test"}:
            detail = f"Failed to send email verification code: {exc}"
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=detail,
        ) from exc
    event_logger.append(
        "auth.email_verification_challenge_created", user.id, {"email": user.email}
    )
    return LoginResponse(
        email_verification_required=True,
        email_verification_challenge_token=challenge,
        email_verification_dev_code=code
        if admin_demo or settings.app_env in {"dev", "test"}
        else None,
    )


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> LoginResponse:
    user = db.scalar(select(User).where(User.email == payload.email))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
        )
    if not user.email_verified:
        return _issue_email_verification_challenge(user)
    if user.role in {"admin", "superuser"} or user.mfa_enabled:
        admin_demo = _uses_admin_demo_code(user)
        code = DEFAULT_ADMIN_DEMO_CODE if admin_demo else str(secrets.randbelow(900000) + 100000)
        code_hash = _mfa_code_hash(user.id, code)
        challenge = create_token(
            str(user.id),
            "mfa",
            settings.mfa_code_minutes,
            extra={"uid": user.id, "code_hash": code_hash},
        )
        try:
            if not admin_demo:
                _send_mfa_code(user.email, code)
        except Exception as exc:
            if isinstance(exc, HTTPException):
                raise
            detail = "Failed to send MFA code"
            if settings.app_env in {"dev", "test"}:
                detail = f"Failed to send MFA code: {exc}"
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=detail,
            ) from exc
        event_logger.append(
            "auth.mfa_challenge_created", user.id, {"email": user.email}
        )
        return LoginResponse(
            mfa_required=True,
            mfa_challenge_token=challenge,
            mfa_dev_code=code if admin_demo or settings.app_env in {"dev", "test"} else None,
        )
    event_logger.append("auth.login", user.id, {"email": user.email})
    pair = _token_pair(user)
    return LoginResponse(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        token_type=pair.token_type,
        must_change_password=pair.must_change_password,
    )


@router.post("/verify-2fa", response_model=TokenPair)
def verify_2fa(payload: VerifyMfaRequest, db: Session = Depends(get_db)) -> TokenPair:
    try:
        token_data = decode_token(payload.challenge_token)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid MFA challenge"
        ) from exc
    if token_data.get("type") != "mfa":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="MFA challenge required"
        )
    user = db.get(User, token_data.get("uid"))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )
    expected = token_data.get("code_hash")
    actual = _mfa_code_hash(user.id, payload.code)
    if not isinstance(expected, str) or not secrets.compare_digest(expected, actual):
        event_logger.append("auth.mfa_failed", user.id, {"email": user.email})
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid MFA code"
        )
    event_logger.append("auth.mfa_verified", user.id, {"email": user.email})
    return _token_pair(user)


@router.post("/verify-email", response_model=TokenPair)
def verify_email(
    payload: VerifyEmailRequest, db: Session = Depends(get_db)
) -> TokenPair:
    try:
        token_data = decode_token(payload.challenge_token)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid verification challenge",
        ) from exc
    if token_data.get("type") != "email_verification":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Email verification challenge required",
        )
    user = db.get(User, token_data.get("uid"))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )
    expected = token_data.get("code_hash")
    actual = _mfa_code_hash(user.id, payload.code)
    if not isinstance(expected, str) or not secrets.compare_digest(expected, actual):
        event_logger.append(
            "auth.email_verification_failed", user.id, {"email": user.email}
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid verification code"
        )
    user.email_verified = True
    db.commit()
    db.refresh(user)
    event_logger.append("auth.email_verified", user.id, {"email": user.email})
    return _token_pair(user)


@router.post(
    "/register", response_model=LoginResponse, status_code=status.HTTP_201_CREATED
)
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> LoginResponse:
    if db.scalar(select(User).where(User.email == payload.email)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Email already exists"
        )
    user = User(
        email=payload.email,
        full_name=f"{payload.last_name} {payload.first_name}",
        password_hash=hash_password(payload.password),
        role="user",
        email_verified=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    event_logger.append(
        "auth.register", user.id, {"email": user.email, "user": user_dict(user)}
    )
    return _issue_email_verification_challenge(user)


@router.post("/refresh", response_model=TokenPair)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenPair:
    try:
        token_data = decode_token(payload.refresh_token)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        ) from exc
    if token_data.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token required"
        )
    user = db.get(User, token_data.get("uid"))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )
    return _token_pair(user)


@router.post("/forgot-password", response_model=Message)
def forgot_password(
    payload: ForgotPasswordRequest, db: Session = Depends(get_db)
) -> Message:
    user = db.scalar(select(User).where(User.email == payload.email))
    event_logger.append(
        "auth.forgot_password", user.id if user else None, {"email": payload.email}
    )
    # Anti-enumeration: always return generic response.
    return Message(message="If this email exists, a reset link has been sent.")


@router.post("/reset-password", response_model=Message)
def reset_password(
    payload: ResetPasswordRequest, db: Session = Depends(get_db)
) -> Message:
    try:
        token_data = decode_token(payload.token)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid reset token"
        ) from exc
    user = db.get(User, token_data.get("uid"))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    db.commit()
    db.refresh(user)
    event_logger.append("auth.reset_password", user.id, {"user": user_dict(user)})
    return Message(message="Password reset successfully.")


@router.post("/change-password", response_model=Message)
def change_password(
    payload: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Message:
    if not verify_password(payload.old_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Old password is incorrect"
        )
    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    db.commit()
    db.refresh(user)
    event_logger.append("auth.change_password", user.id, {"user": user_dict(user)})
    return Message(message="Password changed.")
