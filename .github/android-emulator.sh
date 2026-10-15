#!/usr/bin/env bash
# Starts an Android emulator on a GitHub Ubuntu runner and waits until it has
# booted: Android 14 on x86_64 with Google's apps (which include Chrome),
# accelerated by the runner's KVM. Uses the Android SDK the runner image
# already has, so no third-party action is needed.
#   bash .github/android-emulator.sh
set -euo pipefail
start=$SECONDS

# Says why the emulator didn't come up, on the run's summary page.
fail() {
  local log
  log=$(tail -30 emulator.log 2>/dev/null | tr '\n' '|' | sed 's/%/%25/g; s/|/%0A/g')
  echo "::error title=Android emulator::$1%0A--- emulator.log ---%0A$log"
  exit 1
}

api=${ANDROID_API:-34}
image="system-images;android-$api;google_apis;x86_64"
sdk=${ANDROID_HOME:-$ANDROID_SDK_ROOT}
tools="$sdk/cmdline-tools/latest/bin"

# Let the runner's user open /dev/kvm.
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' |
  sudo tee /etc/udev/rules.d/99-kvm4all.rules > /dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm
[ -e /dev/kvm ] || fail "This runner has no /dev/kvm."

yes | "$tools/sdkmanager" --licenses > /dev/null || true
timeout 600 "$tools/sdkmanager" --install "$image" emulator platform-tools > /dev/null ||
  fail "Installing $image took too long or failed."
echo "Installed the system image after $((SECONDS - start)) s"
echo no | "$tools/avdmanager" create avd --force --name phone --package "$image" --device pixel_6

"$sdk/emulator/emulator" -avd phone -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -camera-back none -camera-front none -memory 4096 \
  > emulator.log 2>&1 &

adb="$sdk/platform-tools/adb"
"$adb" start-server
booted() { [ "$(timeout 10 "$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; }
for _ in $(seq 1 150); do
  booted && break
  pgrep -f qemu-system > /dev/null || fail "The emulator stopped."
  sleep 2
done
booted || fail "It didn't finish booting in 5 minutes."
echo "Booted after $((SECONDS - start)) s"

# No animations to wait for, the screen awake and unlocked.
for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
  "$adb" shell settings put global "$setting" 0
done
"$adb" shell svc power stayon true
"$adb" shell input keyevent 82

chrome=$("$adb" shell dumpsys package com.android.chrome | grep -m1 versionName | tr -d ' \r' || true)
"$adb" shell wm size
[ -n "$chrome" ] || fail "This system image has no Chrome."
android=$("$adb" shell getprop ro.build.version.release | tr -d '\r')
echo "::notice title=Android emulator::Android $android booted in $((SECONDS - start)) s; Chrome $chrome"
