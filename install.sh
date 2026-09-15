#!/bin/sh
set -eu

repository="${NEONXANGI_RELEASE_REPOSITORY:-karaage0703/neonxangi}"
release_base="${NEONXANGI_RELEASE_BASE_URL:-https://github.com/${repository}/releases/latest/download}"

case "$(uname -s)" in
  Linux) platform=linux ;;
  *) echo "neonxangi: the managed installer currently supports Linux" >&2; exit 2 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "neonxangi: supported architectures are x86_64 and arm64" >&2; exit 2 ;;
esac

asset="neonxangi-${platform}-${arch}.tar.gz"
checksums="neonxangi-checksums-sha256.txt"
installer="install-bundle.sh"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/neonxangi-bootstrap.XXXXXX")"
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

download() {
  url=$1
  destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$destination"
  else
    echo "neonxangi: curl or wget is required for installation" >&2
    exit 2
  fi
}

download "$release_base/$asset" "$temporary/$asset"
download "$release_base/$checksums" "$temporary/$checksums"
download "$release_base/$installer" "$temporary/$installer"

checksum_for() {
  awk -v asset="$1" '$2 == asset || $2 == "*" asset { print $1; exit }' "$temporary/$checksums"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

expected_sha256="$(checksum_for "$asset")"
test -n "$expected_sha256" || {
  echo "neonxangi: checksum for $asset is missing" >&2
  exit 1
}
installer_sha256="$(checksum_for "$installer")"
test -n "$installer_sha256" || {
  echo "neonxangi: checksum for $installer is missing" >&2
  exit 1
}
test "$(sha256 "$temporary/$installer")" = "$installer_sha256" || {
  echo "neonxangi: checksum verification failed for $installer" >&2
  exit 1
}

chmod 0755 "$temporary/$installer"
"$temporary/$installer" "$temporary/$asset" "$expected_sha256"
