#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:2283}"
EMAIL="${IMMICH_BOOTSTRAP_EMAIL:-admin@photosync.local}"
NAME="${IMMICH_BOOTSTRAP_NAME:-admin}"
SMOKE_ENV="${IMMICH_SMOKE_ENV:-/opt/photosync/smoke.env}"

umask 077
IFS= read -r -s PASSWORD
export PASSWORD EMAIL NAME
trap 'unset PASSWORD' EXIT

signup_payload="$(python3 -c 'import json, os; print(json.dumps({"email": os.environ["EMAIL"], "name": os.environ["NAME"], "password": os.environ["PASSWORD"]}))')"
signup_status="$(curl --silent --show-error --output /tmp/photosync-signup-response.json --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data "${signup_payload}" \
  "${BASE_URL}/api/auth/admin-sign-up")"

case "${signup_status}" in
  200|201) ;;
  *)
    printf 'admin signup failed with HTTP %s\n' "${signup_status}" >&2
    exit 1
    ;;
esac

login_payload="$(python3 -c 'import json, os; print(json.dumps({"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"]}))')"
login_status="$(curl --silent --show-error --output /tmp/photosync-login-response.json --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data "${login_payload}" \
  "${BASE_URL}/api/auth/login")"

case "${login_status}" in
  200|201) ;;
  *)
    printf 'admin login failed with HTTP %s\n' "${login_status}" >&2
    exit 1
    ;;
esac

ACCESS_TOKEN="$(python3 -c 'import json; print(json.load(open("/tmp/photosync-login-response.json"))["accessToken"])')"
printf 'IMMICH_SMOKE_EMAIL=%s\nIMMICH_SMOKE_PASSWORD=%s\nIMMICH_SMOKE_ACCESS_TOKEN=%s\n' \
  "${EMAIL}" "${PASSWORD}" "${ACCESS_TOKEN}" > "${SMOKE_ENV}"
chmod 600 "${SMOKE_ENV}"

rm /tmp/photosync-signup-response.json /tmp/photosync-login-response.json
printf 'admin-bootstrap-ok\n'
