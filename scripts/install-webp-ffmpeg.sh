#!/usr/bin/env bash
# Installs a static FFmpeg 9.0 beside the distro ffmpeg for animated WebP sources.
# FFmpeg added its animated WebP decoder in 9.0; Ubuntu 26.04 ships 8.0.1.
# The video broker finds it at ~/.local/opt/ffmpeg-9.0/ffmpeg (or $VIDEO_WEBP_FFMPEG).
# BtbN prunes old autobuilds; override FFMPEG_WEBP_URL and FFMPEG_WEBP_SHA256 with a
# current n9.0 linux64-gpl build from https://github.com/BtbN/FFmpeg-Builds/releases.
set -euo pipefail

URL="${FFMPEG_WEBP_URL:-https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-03-12-50/ffmpeg-n9.0.2-45-g1e65c6cd5d-linux64-gpl-9.0.tar.xz}"
SHA256="${FFMPEG_WEBP_SHA256:-1e541f07bff565a18d952e71a3fb7efa1c672f8a5f25a0a950e75957f4f07eee}"
DESTINATION="${FFMPEG_WEBP_DIR:-$HOME/.local/opt/ffmpeg-9.0}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/ffmpeg.tar.xz" "$URL"
echo "$SHA256  $work/ffmpeg.tar.xz" | sha256sum -c --quiet -
tar -xJf "$work/ffmpeg.tar.xz" -C "$work" --wildcards '*/bin/ffmpeg' --strip-components=2
"$work/ffmpeg" -hide_banner -h demuxer=webp_anim | grep -q 'Animated WebP demuxer' \
    || { echo 'This FFmpeg build cannot decode animated WebP.' >&2; exit 1; }
mkdir -p "$DESTINATION"
install -m 0755 "$work/ffmpeg" "$DESTINATION/ffmpeg.new"
mv -f "$DESTINATION/ffmpeg.new" "$DESTINATION/ffmpeg"
"$DESTINATION/ffmpeg" -hide_banner -version | head -1
