#!/usr/bin/env python3
"""Validate data/pets.json before it goes live.

Run this after editing pets.json:

    python tools/validate.py

It checks the things that would quietly corrupt people's saved progress:

  * every pet has a non-empty, unique slug
  * no slug has changed since the last accepted run (tools/slugs.lock)
  * variant ids are ones the file declares
  * required fields are present and the right type
  * `clicks` is null or a well-formed value ("1.5K", "250", "110%")
  * data/pet-images.json is well formed and points at real WebP files (warnings only
    for pets with no entry, so a fresh weekly update does not fail CI before
    tools/add_new_pets.py has been run)

Slug drift is the important one. Progress is stored per pet slug, so if a slug
changes -- which happens if you rename a pet, because the agreed slug format is
the pet name alone -- everyone who had that pet ticked silently loses it. This
script makes that loud. Moving a pet between sources or categories is free.

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

IMAGES_JSON = ROOT / "data" / "pet-images.json"
IMAGES_DIR = ROOT / "assets" / "pets"
# Position in each pet-images.json entry == position in this list.
IMAGE_VARIANTS = ["normal", "golden", "toxic", "galaxy"]

# `clicks` is a display string: a plain/decimal number with an optional
# magnitude suffix ("250", "1.5K", "12Qd"), or a percentage ("110%").
# No leading/trailing zeros, no zero values, no whitespace.
CLICKS_NUMBER = r"(?:[1-9]\d*|0\.\d*[1-9]|[1-9]\d*\.\d*[1-9])"
CLICKS_RE = re.compile(r"^%s(?:[A-Za-z]{1,2}|%%)?$" % CLICKS_NUMBER)
CLICKS_SUFFIXES = {"K", "M", "B", "T", "Qd", "Qn", "Sx", "Sp", "O", "N"}


def check_clicks(value):
    """Return (error, warning) for a pet's `clicks` value; None where fine."""
    if value is None:
        return None, None
    if not isinstance(value, str):
        return "`clicks` must be a string or null, got %r" % (value,), None
    if not CLICKS_RE.match(value):
        return "`clicks` %r is not a number with optional suffix or percentage" % value, None
    suffix = re.sub(r"^[\d.]+", "", value)
    if suffix and suffix != "%" and suffix not in CLICKS_SUFFIXES:
        return None, "unknown clicks suffix %r in %r" % (suffix, value)
    return None, None


def check_images(pet_variants):
    """Cross-check data/pet-images.json against the pets.

    pet_variants maps slug -> list of variant ids. Returns (errors, warnings).
    """
    errors, warnings = [], []
    if not IMAGES_JSON.exists():
        return errors, ["%s does not exist -- the grid view will show text tiles" % IMAGES_JSON.name]
    try:
        images = json.loads(IMAGES_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return ["%s is not valid JSON -- %s" % (IMAGES_JSON.name, exc)], warnings
    if not isinstance(images, dict):
        return ["%s must be an object of slug -> ids" % IMAGES_JSON.name], warnings

    missing_entry = sorted(s for s in pet_variants if s not in images)
    if missing_entry:
        warnings.append(
            "%d pet(s) have no entry in %s (run tools/add_new_pets.py): %s%s"
            % (len(missing_entry), IMAGES_JSON.name, ", ".join(missing_entry[:10]),
               ", ..." if len(missing_entry) > 10 else "")
        )
    stale = sorted(s for s in images if s not in pet_variants)
    if stale:
        warnings.append(
            "%d entr(ies) in %s match no pet: %s" % (len(stale), IMAGES_JSON.name, ", ".join(stale[:10]))
        )

    referenced = set()
    bad_files = []
    no_normal = []
    for slug, ids in images.items():
        if not isinstance(ids, list) or not 3 <= len(ids) <= len(IMAGE_VARIANTS):
            errors.append("%s[%r] must be a list of 3-4 ids, got %r" % (IMAGES_JSON.name, slug, ids))
            continue
        for position, image_id in enumerate(ids):
            if image_id is None:
                continue
            if not isinstance(image_id, str) or not image_id.isdigit():
                errors.append("%s[%r][%d]: id %r is not a numeric string or null"
                              % (IMAGES_JSON.name, slug, position, image_id))
                continue
            referenced.add(image_id)
        if ids[0] is None and slug in pet_variants:
            no_normal.append(slug)
        # Variants the pet has but the entry cannot express.
        for variant_id in pet_variants.get(slug, []):
            if variant_id in IMAGE_VARIANTS and IMAGE_VARIANTS.index(variant_id) >= len(ids):
                warnings.append("%s[%r] has %d ids but the pet has variant %r"
                                % (IMAGES_JSON.name, slug, len(ids), variant_id))

    for image_id in sorted(referenced):
        path = IMAGES_DIR / ("%s.webp" % image_id)
        try:
            with open(path, "rb") as handle:
                head = handle.read(12)
        except OSError:
            bad_files.append("%s (missing)" % path.name)
            continue
        if head[:4] != b"RIFF" or head[8:12] != b"WEBP":
            bad_files.append("%s (empty or not a WebP)" % path.name)
    if bad_files:
        warnings.append(
            "%d referenced image file(s) unusable in assets/pets: %s%s"
            % (len(bad_files), ", ".join(bad_files[:10]), ", ..." if len(bad_files) > 10 else "")
        )
    if no_normal:
        warnings.append(
            "%d pet(s) have no normal image: %s%s"
            % (len(no_normal), ", ".join(no_normal[:10]), ", ..." if len(no_normal) > 10 else "")
        )
    if IMAGES_DIR.is_dir():
        orphans = sorted(f.name for f in IMAGES_DIR.glob("*.webp") if f.stem not in referenced)
        if orphans:
            warnings.append(
                "%d webp file(s) in assets/pets are not referenced by %s: %s%s"
                % (len(orphans), IMAGES_JSON.name, ", ".join(orphans[:5]), ", ..." if len(orphans) > 5 else "")
            )
    return errors, warnings


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
    pet_variants = {}
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
                if isinstance(pet.get("variants"), list):
                    pet_variants[slug] = pet["variants"]

            if not pet.get("name"):
                errors.append("%s (%s): missing name" % (spot, slug))

            if pet.get("source") is not None and not isinstance(pet.get("source"), str):
                errors.append("%s (%s): `source` must be a string or null" % (spot, slug))
            if not pet.get("rarity") or not isinstance(pet.get("rarity"), str):
                errors.append("%s (%s): missing rarity" % (spot, slug))

            clicks_error, clicks_warning = check_clicks(pet.get("clicks"))
            if clicks_error:
                errors.append("%s (%s): %s" % (spot, slug, clicks_error))
            if clicks_warning:
                warnings.append("%s (%s): %s" % (spot, slug, clicks_warning))

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

    image_errors, image_warnings = check_images(pet_variants)
    errors.extend(image_errors)
    warnings.extend(image_warnings)

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
