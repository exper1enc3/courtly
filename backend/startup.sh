#!/bin/sh
set -eu
mkdir -p /home/courtly/uploads
exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
