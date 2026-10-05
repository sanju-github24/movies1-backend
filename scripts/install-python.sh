#!/bin/sh
# The Python half of the build: the scrapers' packages and Playwright's
# Chromium. Run by npm's postinstall, so `npm install` alone is a full build.
#
# The packages go into .pydeps inside the project rather than the system
# Python. Newer build images refuse a system-wide pip install (PEP 668,
# "externally managed environment"), and only the project folder is sure to
# reach the running server. server.js puts .pydeps on PYTHONPATH.
set -e
cd "$(dirname "$0")/.."
PY="$(command -v python3 || command -v python)"

# --break-system-packages is needed on the new images and unknown to older pip;
# try with it, then without.
"$PY" -m pip install --quiet --upgrade --target .pydeps -r requirements.txt --break-system-packages 2>/dev/null \
  || "$PY" -m pip install --quiet --upgrade --target .pydeps -r requirements.txt

PYTHONPATH="$PWD/.pydeps${PYTHONPATH:+:$PYTHONPATH}" "$PY" -m playwright install chromium
