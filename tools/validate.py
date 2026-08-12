#!/usr/bin/env python3
"""Validate data/pets.json before it goes live.

Run this after editing pets.json:

    python tools/validate.py

It checks the things that would quietly corrupt people's saved progress:

  * every pet has a non-empty, unique slug
  * no slug has changed since the last accepted run (tools/slugs.lock)
  * variant ids are ones the file declares
  * required fields are present and the right type

Slug drift is the important one. Progress is stored per pet slug, so if a slug
changes -- which happens if you rename a pet, because the agreed slug format is
the pet name alone -- everyone who had that pet ticked silently loses it. This
script makes that loud. Moving a pet between eggs or categories is free.

If a slug change is intentional, re-run with --accept to update the lock file.
Exits non-zero on any error, so CI can gate on it.
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "pets.json"
LOCK = ROOT / "tools" / "slugs.lock"

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def load_lock():
    if not LOCK.exists():
        return None
    return {
        line.strip()
        for line in LOCK.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }


def write_lock(slugs):
    LOCK.write_text(
        "# Accepted pet slugs. Progress is keyed by these -- do not hand-edit.\n"
        "# Regenerate with: python tools/validate.py --accept\n"
        + "\n".join(sorted(slugs))
        + "\n",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--accept",
        action="store_true",
        help="record the current slugs as the new baseline",
    )
    args = parser.parse_args()

    errors = []
    warnings = []

    try:
        doc = json.loads(DATA.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit("error: %s does not exist" % DATA)
    except json.JSONDecodeError as exc:
        sys.exit("error: %s is not valid JSON -- %s" % (DATA, exc))

    declared_variants = {v.get("id") for v in doc.get("variants", [])}
    if not declared_variants:
        errors.append("no variants declared at the top level")

    categories = doc.get("categories")
    if not isinstance(categories, list):
        sys.exit("error: `categories` must be a list")

    slugs = Counter()
    pet_count = 0
    tick_count = 0
    seen_category_ids = set()

    for cat_index, cat in enumerate(categories):
        where = "categories[%d]" % cat_index
        cat_id = cat.get("id")

        if not cat_id or not SLUG_RE.match(str(cat_id)):
            errors.append("%s: bad or missing category id %r" % (where, cat_id))
        elif cat_id in seen_category_ids:
            errors.append("%s: duplicate category id %r" % (where, cat_id))
        else:
            seen_category_ids.add(cat_id)

        if not cat.get("label"):
            errors.append("%s (%s): missing label" % (where, cat_id))

        pets = cat.get("pets")
        if not isinstance(pets, list):
            errors.append("%s (%s): `pets` must be a list" % (where, cat_id))
            continue

        for pet_index, pet in enumerate(pets):
            spot = "%s (%s).pets[%d]" % (where, cat_id, pet_index)
            pet_count += 1

            slug = pet.get("slug")
            if not slug or not isinstance(slug, str):
                errors.append("%s: missing slug" % spot)
            elif not SLUG_RE.match(slug):
                errors.append("%s: slug %r is not lowercase-kebab-case" % (spot, slug))
            else:
                slugs[slug] += 1

            if not pet.get("name"):
                errors.append("%s (%s): missing name" % (spot, slug))

            variants = pet.get("variants")
            if not isinstance(variants, list):
                errors.append("%s (%s): `variants` must be a list" % (spot, slug))
            else:
                tick_count += len(variants)
                unknown = [v for v in variants if v not in declared_variants]
                if unknown:
                    errors.append(
                        "%s (%s): undeclared variant ids %s" % (spot, slug, unknown)
                    )
                if len(set(variants)) != len(variants):
                    errors.append("%s (%s): duplicate variant ids" % (spot, slug))
                if not variants:
                    warnings.append(
                        "%s (%s): no variants -- nothing to tick" % (spot, slug)
                    )

    for slug, count in sorted(slugs.items()):
        if count > 1:
            errors.append(
                "slug %r appears %d times -- two pets (in any category) would share "
                "one checklist entry" % (slug, count)
            )

    # Slug drift against the accepted baseline.
    current = set(slugs)
    locked = load_lock()

    if locked is not None and not args.accept:
        removed = sorted(locked - current)
        if removed:
            errors.append(
                "%d slug(s) disappeared since the last accepted run -- saved progress "
                "for these would be orphaned:\n    %s"
                % (len(removed), "\n    ".join(removed[:20]))
                + ("\n    ...and %d more" % (len(removed) - 20) if len(removed) > 20 else "")
                + "\n  If this is intentional, re-run with --accept."
            )
        added = sorted(current - locked)
        if added:
            print("New pets since last accepted run: %d" % len(added))
            for slug in added[:10]:
                print("  + %s" % slug)
            if len(added) > 10:
                print("  ...and %d more" % (len(added) - 10))

    for warning in warnings:
        print("warning: %s" % warning)

    if errors:
        print("\n%d error(s):" % len(errors), file=sys.stderr)
        for error in errors:
            print("  - %s" % error, file=sys.stderr)
        return 1

    print(
        "OK -- %d categories, %d pets, %d tickable boxes."
        % (len(categories), pet_count, tick_count)
    )

    if args.accept or locked is None:
        write_lock(current)
        print("Wrote %s (%d slugs)." % (LOCK.relative_to(ROOT), len(current)))

    return 0


if __name__ == "__main__":
    sys.exit(main())
