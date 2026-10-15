#!/usr/bin/env bash
# Starts an Android emulator on a GitHub Ubuntu runner and waits until it has
# booted: Android 14 on x86_64 with Google's apps (which include Chrome),
# accelerated by the runner's KVM. Uses the Android SDK the runner image
# already has, so no third-party action is needed.
#   bash .github/android-emulator.sh
set -euo pipefail

api=${ANDROID_API:-34}
image="system-images;android-$api;google_apis;x86_64"
sdk=${ANDROID_HOME:-$ANDROID_SDK_ROOT}
tools="$sdk/cmdline-tools/latest/bin"

# Let the runner's user open /dev/kvm.
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' |
  sudo tee /etc/udev/rules.d/99-kvm4all.rules > /dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm

yes | "$tools/sdkmanager" --licenses > /dev/null || true
"$tools/sdkmanager" --install "$image" emulator platform-tools > /dev/null
echo no | "$tools/avdmanager" create avd --force --name phone --package "$image" --device pixel_6

"$sdk/emulator/emulator" -avd phone -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -camera-back none -camera-front none -memory 4096 \
  > emulator.log 2>&1 &

adb="$sdk/platform-tools/adb"
"$adb" wait-for-device
for _ in $(seq 1 150); do
  [ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  sleep 2
done
if [ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != 1 ]; then
  echo "::error title=Android emulator::It didn't finish booting in 5 minutes."
  tail -40 emulator.log
  exit 1
fi

# No animations to wait for, the screen awake and unlocked.
for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
  "$adb" shell settings put global "$setting" 0
done
"$adb" shell svc power stayon true
"$adb" shell input keyevent 82

chrome=$("$adb" shell dumpsys package com.android.chrome | grep -m1 versionName | tr -d ' \r' || true)
"$adb" shell wm size
echo "Booted Android $("$adb" shell getprop ro.build.version.release | tr -d '\r'); Chrome: ${chrome:-not installed}"
if [ -z "$chrome" ]; then
  echo "::error title=Android emulator::This system image has no Chrome."
  exit 1
fi
