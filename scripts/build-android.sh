#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CI=1
: "${ANDROID_HOME:?Set ANDROID_HOME to an Android SDK with platform 36 and the Flutter-required NDK/CMake}"
cd "$ROOT/mobile"
command -v mise >/dev/null || { echo "Install mise first" >&2; exit 1; }
mise exec -- flutter pub get
mise run i18n:loader
mise run i18n:keys
for input in pigeon/*.dart; do mise exec -- dart run pigeon --input "$input"; done
mise exec -- dart run build_runner build --delete-conflicting-outputs
mise exec -- flutter build apk --release --target-platform android-arm64 --split-per-abi
mkdir -p "$ROOT/artifacts/releases"
cp build/app/outputs/flutter-apk/app-arm64-v8a-release.apk "$ROOT/artifacts/releases/photosync-android-arm64-v8a-latest.apk"
sha256sum "$ROOT/artifacts/releases/photosync-android-arm64-v8a-latest.apk" > "$ROOT/artifacts/releases/photosync-android-arm64-v8a-latest.apk.sha256"
printf 'APK: %s\n' "$ROOT/artifacts/releases/photosync-android-arm64-v8a-latest.apk"
