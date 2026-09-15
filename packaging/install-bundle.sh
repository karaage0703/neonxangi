#!/usr/bin/env bash
set -euo pipefail

bundle="${1:-}"
expected_sha256="${2:-}"
test -f "$bundle" || { echo "usage: install-bundle.sh BUNDLE SHA256" >&2; exit 2; }
test "$expected_sha256" != "" || { echo "expected SHA-256 is required" >&2; exit 2; }

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$bundle" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "$bundle" | awk '{print $1}')"
fi
test "$actual_sha256" = "$expected_sha256" || {
  echo "bundle SHA-256 verification failed" >&2
  exit 1
}

temporary="$(mktemp -d "${TMPDIR:-/tmp}/neonxangi-install.XXXXXX")"
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

entries="$temporary/entries.txt"
details="$temporary/details.txt"
tar -tzf "$bundle" > "$entries"
tar -tvzf "$bundle" > "$details"
root="$(sed -n '1s,/.*,,p' "$entries")"
test "$root" != "" || { echo "bundle is empty" >&2; exit 1; }
LC_ALL=C awk -v root="$root" '
  BEGIN { ok = 1 }
  {
    if ($0 == "" || $0 ~ /^\// || $0 ~ /\\/ || $0 ~ /[[:cntrl:]]/) ok = 0
    count = split($0, parts, "/")
    if (parts[1] != root) ok = 0
    for (i = 1; i <= count; i++) if (parts[i] == "." || parts[i] == "..") ok = 0
  }
  END { exit ok ? 0 : 1 }
' "$entries" || { echo "bundle contains an unsafe path" >&2; exit 1; }
LC_ALL=C awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }' "$details" || {
  echo "bundle may contain only files and directories" >&2
  exit 1
}

app_root="${NEONXANGI_APP_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/neonxangi/app}"
command_dir="${NEONXANGI_COMMAND_DIR:-$HOME/.local/bin}"
versions="$app_root/versions"
target="$versions/$root"
staging="$app_root/staging/install.$$"
mkdir -p "$versions" "$app_root/staging" "$app_root/bin" "$command_dir"
rm -rf -- "$staging"
mkdir "$staging"
tar -xzf "$bundle" -C "$staging"
unpacked="$staging/$root"
test -x "$unpacked/runtime/bin/node" || { echo "bundle has no Node.js runtime" >&2; exit 1; }
test -x "$unpacked/runtime/bin/openshell" || { echo "bundle has no OpenShell runtime" >&2; exit 1; }
test -x "$unpacked/bin/neonxangi" || { echo "bundle has no Neon Xangi launcher" >&2; exit 1; }
"$unpacked/bin/neonxangi" --version >/dev/null
"$unpacked/runtime/bin/openshell" --version >/dev/null

if [ -e "$target" ]; then
  current_target="$(readlink -f "$app_root/current" 2>/dev/null || true)"
  if [ "$current_target" = "$target" ]; then
    rm -rf -- "$staging"
    printf 'Already up to date: %s\n' "$target"
    exit 0
  fi
  echo "target version already exists but is not current: $target" >&2
  exit 1
fi
mv "$unpacked" "$target"
rm -rf -- "$staging"
next="$app_root/.current.$$"
ln -s "$target" "$next"
mv -T "$next" "$app_root/current"

launcher="$app_root/bin/neonxangi"
printf '%s\n' '#!/bin/sh' 'set -eu' 'app_root="${NEONXANGI_APP_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/neonxangi/app}"' 'exec "$app_root/current/bin/neonxangi" "$@"' > "$launcher"
chmod 0755 "$launcher"
link="$command_dir/neonxangi"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "$link exists and is not a symbolic link" >&2
  exit 1
fi
next_link="$command_dir/.neonxangi.$$"
ln -s "$launcher" "$next_link"
mv -T "$next_link" "$link"

if [ "${NEONXANGI_INSTALL_MODE:-install}" = update ]; then
  printf 'Updated to %s\n' "$target"
  printf 'Restart a running Neon Xangi host to use the new version.\n'
else
  printf 'Installed %s\n' "$target"
  printf 'Next: %s setup\n' "$link"
fi
