#!/usr/bin/env python3
"""Quattro Dash stress-calibration helper (round 10).

Reads a grade plan from --plan (JSON: [{"mib": <MiB>, "secs": <seconds>}, ...]),
allocates that much ANONYMOUS memory one grade at a time, retains the whole
ladder, prints one JSON progress line at the start of each grade on stdout
(the dash bins its samples by these lines), touches pages spread across the
grade window (never in one burst - an unthrottled fault-in would spike PSI
mid-grade and smear every measurement the dash is trying to take), and exits.

It writes NOTHING, ever: no files, no logs, no temp dirs, no child processes. The
dash's tests pin that law by reading this source. Exit codes: 0 finished,
2 MemoryError (the cgroup ceiling caught a grade), 3 bad plan.

It runs under a transient systemd user unit that owns the real rails
(MemoryMax clamped below physical RAM, MemorySwapMax at half the reserve,
RuntimeMaxSec as the machine-level time cap, TimeoutStopSec so cancel lands in
seconds). SIGTERM - what `systemctl stop` sends - kills it by python's default
disposition; that IS the cancel path.
"""

import json
import sys
import time

# The plan law mirrors what quattro.js builds and what its tests pin: 1..4
# grades, each between 1 and 32768 MiB held, each 1..60 seconds.
MAX_GRADES = 4
MAX_GRADE_MIB = 32768
MAX_GRADE_SECS = 60

PAGE = 4096
SLICE_MS = 200


def fail_plan(why):
    sys.stderr.write("calibrate: bad plan: %s\n" % why)
    sys.exit(3)


def parse_plan(argv):
    if "--plan" not in argv:
        fail_plan("--plan is required")
    raw = argv[argv.index("--plan") + 1]
    try:
        plan = json.loads(raw)
    except Exception as exc:  # noqa: BLE001 - any parse noise is a bad plan
        fail_plan("not JSON: %s" % exc)
    if not isinstance(plan, list) or not (1 <= len(plan) <= MAX_GRADES):
        fail_plan("expected 1..%d grades" % MAX_GRADES)
    for grade in plan:
        if not isinstance(grade, dict) or "mib" not in grade or "secs" not in grade:
            fail_plan("each grade needs mib and secs")
        mib, secs = grade["mib"], grade["secs"]
        if not isinstance(mib, int) or not (1 <= mib <= MAX_GRADE_MIB):
            fail_plan("mib must be an integer 1..%d" % MAX_GRADE_MIB)
        if not isinstance(secs, int) or not (1 <= secs <= MAX_GRADE_SECS):
            fail_plan("secs must be an integer 1..%d" % MAX_GRADE_SECS)
    return plan


def emit(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def main():
    plan = parse_plan(sys.argv)
    ladder = []          # every grade's buffer, retained: the ladder climbs
    held_mib = 0
    start = time.monotonic()

    for index, grade in enumerate(plan):
        mib, secs = grade["mib"], grade["secs"]
        try:
            buf = bytearray(mib << 20)
        except MemoryError:
            emit({"event": "error", "why": "allocator refused grade %d" % index})
            sys.exit(2)

        ladder.append(buf)
        held_mib += mib

        emit({
            "event": "grade",
            "grade": index,
            "mib": mib,
            "cumMib": held_mib,
            "at": round(time.monotonic() - start, 2),
        })

        # Touch the new pages spread across the first half of the grade window:
        # the point of a graded ladder is a slope the dash can read, not a
        # wall of page faults at the top of each step.
        pages = (mib << 20) // PAGE
        per_slice = max(1, pages // max(1, (secs * 1000 // SLICE_MS) // 2))
        touched = 0
        while touched < pages:
            step = min(per_slice, pages - touched)
            for p in range(touched, touched + step):
                buf[p * PAGE] = 1
            touched += step
            if touched < pages:
                time.sleep(SLICE_MS / 1000.0)

        # Hold through the rest of the grade window in small slices, so the
        # grade's end lands near its planned mark without a long unsleepable
        # block.
        grade_end = start + sum(g["secs"] for g in plan[: index + 1])
        while time.monotonic() < grade_end:
            time.sleep(SLICE_MS / 1000.0)

    emit({"event": "done", "cumMib": held_mib, "at": round(time.monotonic() - start, 2)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
