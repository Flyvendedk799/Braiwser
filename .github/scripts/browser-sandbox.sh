#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
# Disposable CI only. Permit user namespaces for the installed test browsers,
# keeping Chromium's sandbox enabled and the host-wide restriction intact.
# https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
cat <<EOF | sudo tee /etc/apparmor.d/braiwser-ci >/dev/null
abi <abi/4.0>,
include <tunables/global>
profile braiwser-ci-chrome "${HOME}/.cache/ms-playwright/**/chrome" flags=(unconfined) {
  userns,
}
profile braiwser-ci-headless "${HOME}/.cache/ms-playwright/**/chrome-headless-shell" flags=(unconfined) {
  userns,
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/braiwser-ci
