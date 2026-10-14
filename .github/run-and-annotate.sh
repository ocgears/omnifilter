#!/usr/bin/env bash
# Runs a command and, if it fails, repeats the important part of its output as
# a GitHub annotation, so the failure shows on the run's summary page (and to
# anyone without access to the full logs).
#   bash .github/run-and-annotate.sh npx mocha server/test

log=$(mktemp)
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
  failures=$(grep -E "failing|passing|Error|error:|ERR!|  [0-9]+\) |AssertionError|Segmentation|Aborted|core dumped|FAILED|CRASHED|TIMED OUT|^Device:|[0-9]+ ok, |waiting for|element is|intercepts pointer|retrying" "$log" | head -40)
  summary="$failures"$'\n'"--- last lines ---"$'\n'"$(tail -25 "$log")"
  # An annotation is one line, so encode %, CR and LF the way GitHub expects.
  summary=${summary//'%'/'%25'}
  summary=${summary//$'\r'/'%0D'}
  summary=${summary//$'\n'/'%0A'}
  echo "::error title=$1 failed with exit code $status::$summary"
fi
exit "$status"
