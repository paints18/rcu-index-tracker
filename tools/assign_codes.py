#!/usr/bin/env python3
"""Maintain data/codes.json — the permanent slug -> integer ledger.

Backup codes encode a player's ticks as a bitset indexed by these integers,
which is what keeps them short (~500 characters instead of ~5,700). For that to
work the integers must be *permanent*:

  * a slug keeps its integer forever, so old backup codes keep decoding;
  * integers are never reused, so a deleted pet's slot can never be
    reinterpreted as some other pet and silently misattribute progress;
  * new pets append at the end, so adding pets never shifts existing ones and
    every backup code ever issued stays valid.

You do not run this by hand. The GitHub Action in .github/workflows/codes.yml
runs it whenever data/pets.json changes on main and commits the result back.
Your workflow stays: edit data/pets.json, push.

Run manually if you want:  python tools/assign_codes.py
Exits 0 if nothing changed, 0 after writing if it did, non-zero on error.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PETS = ROOT / "data" / "pets.json"
CODES = ROOT / "data" / "codes.json"


def load_ledger():
    if not CODES.exists():
        return {"nextCode": 0, "codes": {}}

    try:
        ledger = json.loads(CODES.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit("error: %s is not valid JSON -- %s" % (CODES, exc))

    codes = ledger.get("codes")
    if not isinstance(codes, dict):
        sys.exit("error: %s is missing its `codes` object" % CODES)

    next_code = ledger.get("nextCode")
    if not isinstance(next_code, int):
        next_code = (max(codes.values()) + 1) if codes else 0

    # Guard against a hand-edit that would let an integer be handed out twice.
    used = list(codes.values())
    if len(set(used)) != len(used):
        sys.exit("error: %s contains duplicate integers -- refusing to continue" % CODES)
    if used and next_code <= max(used):
        sys.exit(
            "error: %s has nextCode=%d but already uses %d -- refusing to reuse integers"
            % (CODES, next_code, max(used))
        )

    return {"nextCode": next_code, "codes": codes}


def main():
    try:
        doc = json.loads(PETS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit("error: %s does not exist" % PETS)
    except json.JSONDecodeError as exc:
        sys.exit("error: %s is not valid JSON -- %s" % (PETS, exc))

    slugs = [
        pet["slug"]
        for cat in doc.get("categories", [])
        for pet in cat.get("pets", [])
        if pet.get("slug")
    ]

    ledger = load_ledger()
    codes = ledger["codes"]
    next_code = ledger["nextCode"]

    # Assign in file order so a batch of new pets gets a contiguous, tidy range.
    added = []
    for slug in slugs:
        if slug not in codes:
            codes[slug] = next_code
            next_code += 1
            added.append(slug)

    # Slugs that vanished keep their entry. The integer stays burned so it can
    # never be handed to a different pet, and a pet that comes back gets its
    # original integer -- old backup codes still decode it correctly.
    retired = sorted(set(codes) - set(slugs))

    payload = {
        "_comment": (
            "Permanent pet-slug -> integer ledger, maintained by "
            "tools/assign_codes.py. Do not hand-edit: changing or reusing an "
            "integer invalidates every backup code players have saved."
        ),
        "nextCode": next_code,
        "codes": dict(sorted(codes.items())),
    }
    serialized = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"

    unchanged = CODES.exists() and CODES.read_text(encoding="utf-8") == serialized
    if unchanged:
        print("codes.json already up to date (%d pets, %d retired)." % (len(slugs), len(retired)))
        return 0

    CODES.write_text(serialized, encoding="utf-8")
    print("Wrote %s" % CODES.relative_to(ROOT))
    print("  tracked slugs: %d" % len(slugs))
    print("  newly coded:   %d" % len(added))
    for slug in added[:10]:
        print("    + %-44s -> %d" % (slug, codes[slug]))
    if len(added) > 10:
        print("    ...and %d more" % (len(added) - 10))
    if retired:
        print("  retired (kept, integers burned): %d" % len(retired))
    return 0


if __name__ == "__main__":
    sys.exit(main())
