#!/bin/sh
# Write the UnifAI session file from the UNIFAI_SESSION_JSON env var.
# This lets you inject the session cookie purely via an environment variable
# without needing a mounted Secret or volume.

if [ -n "$UNIFAI_SESSION_JSON" ]; then
  printf '%s' "$UNIFAI_SESSION_JSON" > /tmp/unifai-session.json
  export UNIFAI_SESSION_FILE=/tmp/unifai-session.json
  echo "[entrypoint] UnifAI session file written to $UNIFAI_SESSION_FILE"
else
  echo "[entrypoint] WARNING: UNIFAI_SESSION_JSON is not set — API calls will fail unless UNIFAI_SESSION_FILE points to an existing file."
fi

exec python app.py
