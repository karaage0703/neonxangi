#!/usr/bin/env bash
set -euo pipefail

project_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(node -p "require('${project_root}/package.json').version")"
platform="${NEONXANGI_BUNDLE_PLATFORM:-$(node -p 'process.platform')}"
arch="${NEONXANGI_BUNDLE_ARCH:-$(node -p 'process.arch')}"
node_binary="${NEONXANGI_BUNDLE_NODE_BINARY:-$(command -v node)}"
openshell_binary="${NEONXANGI_BUNDLE_OPENSHELL_BINARY:-$(command -v openshell || true)}"
openshell_version="${NEONXANGI_BUNDLE_OPENSHELL_VERSION:-0.0.116}"
output="${1:-${project_root}/release-bundles/neonxangi-${platform}-${arch}.tar.gz}"

case "$platform/$arch" in
  linux/arm64|linux/x64|darwin/arm64|darwin/x64) ;;
  *) echo "unsupported bundle target: $platform/$arch" >&2; exit 2 ;;
esac
test -x "$node_binary" || { echo "executable Node.js runtime is required" >&2; exit 2; }
test -x "$openshell_binary" || { echo "executable OpenShell runtime is required" >&2; exit 2; }
test "$($node_binary -p 'process.platform')/$($node_binary -p 'process.arch')" = "$platform/$arch" || {
  echo "Node.js runtime target does not match $platform/$arch" >&2
  exit 2
}
"$openshell_binary" --version | grep -Eq "(^|[[:space:]])${openshell_version}([[:space:]]|$)" || {
  echo "OpenShell ${openshell_version} is required for this bundle" >&2
  exit 2
}
test -f "$project_root/dist/cli.js" || { echo "run npm run build first" >&2; exit 2; }

temporary="$(mktemp -d "${TMPDIR:-/tmp}/neonxangi-bundle.XXXXXX")"
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

name="neonxangi-${version}-${platform}-${arch}"
root="$temporary/$name"
mkdir -p "$root/runtime/bin" "$root/bin"
cp "$node_binary" "$root/runtime/bin/node"
chmod 0755 "$root/runtime/bin/node"
cp "$openshell_binary" "$root/runtime/bin/openshell"
chmod 0755 "$root/runtime/bin/openshell"
cp -R "$project_root/bin/." "$root/bin/"
chmod 0755 "$root/bin/neonxangi"
cp -R "$project_root/dist" "$project_root/web" "$project_root/blueprint" "$project_root/docs" "$root/"
cp "$project_root/Dockerfile" "$project_root/package.json" "$project_root/package-lock.json" "$root/"
cp "$project_root/README.md" "$project_root/README.en.md" "$root/"
cp "$project_root/install.sh" "$root/"
chmod 0755 "$root/install.sh"
cp "$project_root/LICENSE" "$root/"
cp -R "$project_root/licenses" "$root/"

npm --prefix "$root" ci --omit=dev --ignore-scripts
find "$root" -type f \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '.npmrc' \) -delete
find "$root" -type l -delete
find "$root" -exec touch -h -t 198001010000 {} +
mkdir -p "$(dirname -- "$output")"
(
  cd "$temporary"
  LC_ALL=C find "$name" -type f -print | LC_ALL=C sort > files.txt
  tar -cf - -T files.txt
) | gzip -n > "$output"
printf '%s\n' "$output"
