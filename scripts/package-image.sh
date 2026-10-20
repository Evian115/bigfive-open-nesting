#!/usr/bin/env bash
set -euo pipefail
umask 077

nesting_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$nesting_root"
if ! git diff --quiet || ! git diff --cached --quiet; then
  printf 'Commit tracked changes before packaging so the image revision identifies its source.\n' >&2
  exit 1
fi
nesting_revision="$(git rev-parse HEAD)"
nesting_version="$(date -u +%Y%m%d)-$(git rev-parse --short=8 HEAD)"
nesting_platform="${NESTING_PLATFORM:-linux/amd64}"
nesting_tag="bigfive-open-nesting:$nesting_version"
nesting_created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p dist
nesting_stage="$(mktemp -d "$nesting_root/dist/.package.XXXXXX")"
trap 'rm -rf -- "$nesting_stage"' EXIT

docker build --platform "$nesting_platform" \
  --label "org.opencontainers.image.source=https://github.com/Evian115/bigfive-open-nesting" \
  --label "org.opencontainers.image.revision=$nesting_revision" \
  --label "org.opencontainers.image.created=$nesting_created" \
  --label "org.opencontainers.image.version=$nesting_version" \
  -t "$nesting_tag" -t bigfive-open-nesting:latest .
docker image save -o "$nesting_stage/image.tar" "$nesting_tag" bigfive-open-nesting:latest
cp deploy/compose.image.yaml "$nesting_stage/compose.yaml"
cp .env.example "$nesting_stage/.env.example"
cp deploy/nginx.conf.example "$nesting_stage/nginx.conf.example"
cp deploy/README.md "$nesting_stage/README.md"
sed -i 's|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://test.example.com|; s/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' "$nesting_stage/.env.example"
nesting_archive="bigfive-open-nesting-${nesting_platform//\//-}-$nesting_version.tar.gz"
tar -C "$nesting_stage" -cf - image.tar compose.yaml .env.example nginx.conf.example README.md | gzip -1 > "dist/$nesting_archive"
sha256sum "dist/$nesting_archive" > "dist/$nesting_archive.sha256"
printf 'Deployment package: %s/dist/%s\nImage: %s\nPlatform: %s\n' "$nesting_root" "$nesting_archive" "$nesting_tag" "$nesting_platform"
