# Courtly Implementation

This repository now includes a full-stack baseline implementation derived from `docs/`:

- Backend: FastAPI + SQLAlchemy + SQLite + JWT auth + Argon2id + PII encryption + event log.
- Frontend: React + Vite test UI for auth/discovery/booking/cabinet flows.
- Tests: API integration tests for health and core booking lifecycle.

## Structure

- `backend/app/main.py` - API bootstrap and startup seed.
- `backend/app/routers/` - endpoint groups (`auth`, `courts`, `bookings`, `me`, `dashboard`, `admin`).
- `backend/app/models.py` - core data model (`users`, `courts`, `bookings`, `rbac`, etc.).
- `backend/app/event_log.py` - append-only JSONL hash-chain event log.
- `backend/replay_cli.py` - replay command-line utility.
- `backend/restore_db.py` - restore `courtly.db` from `event_log.jsonl`.
- `frontend/src/` - minimal UI and API client.

## Backend Run

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Default seeded superuser:

- email: `superuser@courtly.example.com`
- password: `ChangeMeNow123!`

The configured default superuser uses the fixed demo email code `123456` for
email verification and login MFA in all environments, including production.
No verification email is sent for this account; the UI shows the demo code.
The password and a valid, unexpired challenge token are still required.

## Frontend Run

```bash
cd frontend
npm install
npm run dev
```

Optional API base override:

```bash
VITE_API_BASE=http://localhost:8000/api npm run dev
```

## Stored XSS Demo

Requests sent through "Написати модератору" intentionally render HTML and execute
JavaScript when a moderator, admin, or superuser opens the dashboard tab
"Запити до модератора". The inbox shows the latest 100 messages from existing
users, persisted in the event log. No environment flag is required:

```bash
cd frontend
npm run dev
```

Open a booking in the cabinet, send a moderator request containing
`<script>alert('XSS demo')</script>`, then open the moderator inbox in the dashboard.
HTML event handlers such as `<img src=x onerror="alert('XSS demo')">` also execute.
Plain JavaScript without HTML tags remains text.

This deliberately allows stored moderator requests to run with the viewer's page
privileges in both development and production builds. Review comments are escaped
text and do not execute JavaScript. All review cards include the author's email
in a `data-author-email` HTML attribute, accessible in the DOM but not shown in
the UI. Public review responses include this email as well.

## Azure CI/CD

Pushing to `main` runs two GitHub Actions workflows:

- `Deploy backend to Azure` packages `backend/` and deploys to the Python 3.11 App Service `courtlyback`, then checks `/api/health`.
- `Deploy frontend to Azure` builds with Node.js 22 and deploys `frontend/dist` to Static Web App `courtlyfront` at https://courtly.click.

Both workflows can also be started manually from GitHub Actions using **Run workflow**. Deployments for each app run sequentially. Other branches do not deploy to production.

Backend authentication uses the existing Azure managed identity and OIDC, restricted to `exper1enc3/courtly` on `main`, with Website Contributor access only to `courtlyback`. The frontend uses repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN_ICY_RIVER_09D809C0F`.

The frontend build sets `VITE_API_BASE` to `https://courtlyback-cfgaheagazd8f9gk.canadacentral-01.azurewebsites.net/api`. This is a public URL, not a credential.

Backend App Service settings configure `COURTLY_CORS_ORIGINS` (a JSON array), `COURTLY_DATABASE_URL`, `COURTLY_EVENT_LOG_PATH`, `COURTLY_UPLOADS_DIR`, `COURTLY_JWT_SECRET`, and `COURTLY_ENCRYPTION_KEK_B64`. Data lives under `/home/courtly`, outside deployment files. Keep the encryption key stable to retain access to encrypted profile data. Application secrets stay in Azure settings.

To redeploy an older release, revert the relevant commit on `main` and push. This redeploys code; it does not reverse database changes.

## Tests

```bash
cd backend
pytest
```

## Replay CLI

```bash
cd backend
python replay_cli.py
```

## DB Restore from Event Log

```bash
cd backend
python restore_db.py --force
```

Use this after deleting `courtly.db` (or with `--force` to recreate it). The script verifies the event-log hash chain, recreates schema/default seed data, and replays events.
