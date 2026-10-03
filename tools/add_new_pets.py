#!/usr/bin/env python3
"""Bring data/pets.json up to date with the Powerful Studio pet list.

One run does three things, in order:

  1. Adds pets the API has and the tracker does not.
  2. Fills blank `clicks` on any pet (new or existing).
  3. Downloads icons for pets that lack them and rewrites data/pet-images.json.

It is a dry run unless you pass --write.

What it never does to a pet that is already in data/pets.json: change its slug,
name, egg, rarity, variants or position, or overwrite a `clicks` value that is
filled in. Progress is stored per slug, so slugs are never regenerated, and
everything you have entered by hand stays as it is. Before writing, the result is
compared against the original and the run is aborted if anything but a blank
`clicks` differs on an existing pet.

New pets
--------
Matched to existing pets by name, ignoring case and punctuation. Pets the tracker
deliberately omits (IGNORED_KEYS in assets/js/api-import.js) are skipped. Each new
pet gets:

  slug      the name, lowercased with hyphens (same rule as tools/xlsx_to_json.py)
  rarity    from the API
  variants  3 image slots -> normal, golden, toxic; 4 -> adds galaxy
  clicks    see below
  egg       null: the API has no egg, so you fill it in
  tab       world 1-4 and exclusives as the API says; event pets by their currency
            (`special.name`), no currency -> no-currency
  position  appended to the end of the tab: the API has no order, so you move it

A pet whose tab cannot be worked out (no category, or a currency this tracker has
no tab for) is reported and left out. A slug that already exists is also reported.

Clicks
------
Supreme and Ultimate pets get the API's percent ("110%"). Every other pet gets the
API's base the way the game displays it: the game divides the base by the suffix's
power of ten as a float and cuts the result off after two decimals (never rounds),
so a base of 1.16e30 shows as 1.15N. This reproduced every existing non-percent
clicks value when it was written, and predicted Magnet Shard's before it was
checked in game. About 1% of pets are affected and it cannot be told by eye.
Suffixes are K M B T Qd Qn Sx Sp O N; a base past that is reported, not filled.
Existing values that disagree with the rule are listed and left alone.

Icons
-----
150 px thumbnails from Roblox, scaled to 112 px and saved as WebP (quality 60) in
assets/pets/<asset id>.webp, which needs Pillow. Files already there and valid are
skipped; writes go through a temp file. data/pet-images.json maps slug ->
[normal, golden, toxic, galaxy] asset ids, null where there is none. Blocked or not
yet generated icons come back as null and are retried on the next run.

Code assignment is not done here: .githooks/pre-commit runs tools/assign_codes.py
when data/pets.json is committed.

Run:  python tools/add_new_pets.py            (dry run)
      python tools/add_new_pets.py --write
Options: --api FILE (a saved API response), --skip-images, --root DIR (another copy
of the repo layout, for testing)
"""

import argparse
import copy
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from decimal import Decimal
from io import BytesIO
from pathlib import Path

API = "https://public-api.powerfulstudio.xyz/rcu/v1/directories/pets"
THUMBS = "https://thumbnails.roblox.com/v1/assets?assetIds=%s&size=150x150&format=Png"
BATCH = 100

SUFFIXES = ["", "K", "M", "B", "T", "Qd", "Qn", "Sx", "Sp", "O", "N"]
PERCENT_RARITIES = {"Supreme", "Ultimate"}

# The API names an event pet's currency in camelCase; these are the ones whose tab
# id is not just the same words joined with hyphens.
CURRENCY_TAB = {"summerShells": "shells"}
NO_CURRENCY_TAB = "no-currency"

ICON_SIZE = 112
ICON_QUALITY = 60

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_END = b"IEND\xaeB`\x82"
RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504}
MAX_RETRY_WAIT = 60


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def norm(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def slugify(value):
    """Lowercase kebab-case, ASCII alnum only. Same rule as xlsx_to_json.py."""
    text = str(value or "").strip().lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def kebab(camel):
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", camel).lower()


def retry_wait(error, attempt):
    header = getattr(error, "headers", None)
    value = header.get("Retry-After") if header is not None else None
    try:
        if value is not None:
            return min(max(float(value), 0), MAX_RETRY_WAIT)
    except ValueError:
        pass
    return min(1.5 * (attempt + 1) * (3 if getattr(error, "code", None) == 429 else 1), MAX_RETRY_WAIT)


def get(url, tries=4):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code not in RETRY_STATUS or attempt == tries - 1:
                raise
            time.sleep(retry_wait(error, attempt))
        except Exception as error:  # timeouts, resets, DNS, truncated reads
            if attempt == tries - 1:
                raise
            time.sleep(retry_wait(error, attempt))


def get_json(url):
    return json.loads(get(url))


def write_atomic(path, data):
    temp = path.with_name(path.name + ".part")
    temp.write_bytes(data)
    os.replace(temp, path)


def ignored_keys(root):
    """The pets the tracker omits on purpose, read from the JS so there is one list."""
    try:
        source = (root / "assets" / "js" / "api-import.js").read_text(encoding="utf-8")
        body = re.search(r"IGNORED_KEYS\s*=\s*new Set\(\[(.*?)\]\)", source, re.S).group(1)
        return set(re.findall(r'"([^"]+)"', body))
    except (OSError, AttributeError):
        print("warning: could not read IGNORED_KEYS from assets/js/api-import.js", file=sys.stderr)
        return set()


# --------------------------------------------------------------------------- #
# clicks
# --------------------------------------------------------------------------- #

def display_clicks(base):
    """The base as the game shows it, or None if it is past the known suffixes."""
    step = max(Decimal(repr(base)).adjusted() // 3, 0)
    if step >= len(SUFFIXES):
        return None
    shown = math.floor((base / (10.0 ** (3 * step))) * 100) / 100
    return format(Decimal(repr(shown)).normalize(), "f") + SUFFIXES[step]


def display_percent(percent):
    return format(Decimal(repr(round(percent, 2))).normalize(), "f") + "%"


def expected_clicks(rarity, multipliers):
    """(value, problem). value is None when it cannot be worked out."""
    if rarity in PERCENT_RARITIES:
        if "percent" not in multipliers:
            return None, "no percent in the API"
        return display_percent(multipliers["percent"]), None
    if "base" not in multipliers:
        return None, "no base in the API"
    value = display_clicks(multipliers["base"])
    if value is None:
        return None, "base %s is past the known suffixes" % multipliers["base"]
    return value, None


# --------------------------------------------------------------------------- #
# step 1: new pets
# --------------------------------------------------------------------------- #

def tab_for(entry, tab_ids):
    """(tab id, problem)."""
    category = entry.get("category")
    if not category:
        return None, "the API gives no category"
    if category != "limited":
        return (category, None) if category in tab_ids else (None, "no tab named %r" % category)
    currency = (entry.get("multipliers") or {}).get("special", {}).get("name")
    if not currency:
        return (NO_CURRENCY_TAB, None) if NO_CURRENCY_TAB in tab_ids else (None, "no tab named %r" % NO_CURRENCY_TAB)
    tab = CURRENCY_TAB.get(currency, kebab(currency))
    return (tab, None) if tab in tab_ids else (None, "currency %r has no tab (add one, then rerun)" % currency)


def find_new(data, entries, ignored):
    """New pet dicts appended to data in place. Returns (added, skipped)."""
    known = {norm(p["name"]) for c in data["categories"] for p in c["pets"]}
    slugs = {p["slug"] for c in data["categories"] for p in c["pets"]}
    tabs = {c["id"]: c for c in data["categories"]}
    variant_ids = [v["id"] for v in data["variants"]]
    added, skipped = [], []

    for name, entry in entries.items():
        key = norm(name)
        if key in known or key in ignored:
            continue
        tab, problem = tab_for(entry, tabs)
        if problem:
            skipped.append((name, problem))
            continue
        slug = slugify(name)
        if not slug or slug in slugs:
            skipped.append((name, "slug %r is empty or already used" % slug))
            continue
        slots = len(entry.get("images") or [])
        if not 3 <= slots <= len(variant_ids):
            skipped.append((name, "%d image slots; cannot tell its variants" % slots))
            continue
        rarity = str(entry.get("rarity") or "").capitalize()
        pet = {
            "slug": slug,
            "name": name,
            "egg": None,
            "rarity": rarity,
            "clicks": None,
            "variants": variant_ids[:slots],
        }
        tabs[tab]["pets"].append(pet)
        slugs.add(slug)
        added.append((tab, pet))
    return added, skipped


# --------------------------------------------------------------------------- #
# step 2: blank clicks
# --------------------------------------------------------------------------- #

def fill_clicks(data, by_name):
    filled, disagree, problems = [], [], []
    for category in data["categories"]:
        for pet in category["pets"]:
            entry = by_name.get(norm(pet["name"]))
            if entry is None:
                continue
            expected, problem = expected_clicks(pet["rarity"], entry.get("multipliers") or {})
            have = pet.get("clicks")
            if have:
                if expected is not None and have != expected:
                    disagree.append((pet["name"], have, expected))
                continue
            if expected is None:
                problems.append((pet["name"], problem))
                continue
            pet["clicks"] = expected
            filled.append((category["id"], pet["name"], expected))
    return filled, disagree, problems


# --------------------------------------------------------------------------- #
# step 3: icons
# --------------------------------------------------------------------------- #

def is_png(data):
    return (
        len(data) > 33
        and data[:8] == PNG_SIGNATURE
        and data[12:16] == b"IHDR"
        and data.rstrip(b"\x00").endswith(PNG_END)
    )


def is_webp(data):
    return (
        len(data) > 12
        and data[:4] == b"RIFF"
        and data[8:12] == b"WEBP"
        and int.from_bytes(data[4:8], "little") == len(data) - 8
    )


def webp_on_disk(path):
    try:
        return is_webp(path.read_bytes())
    except OSError:
        return False


def to_webp(png_data):
    try:
        from PIL import Image
    except ImportError:
        sys.exit("Pillow is required to convert icons to WebP: pip install pillow")
    out = BytesIO()
    image = Image.open(BytesIO(png_data)).convert("RGBA").resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
    image.save(out, "WEBP", quality=ICON_QUALITY, method=6, alpha_quality=100)
    return out.getvalue()


def parse_images(entry):
    ids = []
    for raw in entry.get("images") or []:
        if raw and "://" in str(raw):
            ids.append(str(raw).split("://", 1)[1] or None)
        elif raw and str(raw).isdigit():
            ids.append(str(raw))
        else:
            ids.append(None)
    return ids


def build_mapping(categories, by_name, previous):
    """slug -> ids. A pet the API no longer matches keeps its previous entry."""
    mapping = {}
    for category in categories:
        for pet in category["pets"]:
            entry = by_name.get(norm(pet["name"]))
            ids = parse_images(entry) if entry is not None else []
            if any(ids):
                mapping[pet["slug"]] = ids
            elif pet["slug"] in previous:
                mapping[pet["slug"]] = previous[pet["slug"]]
    return mapping


def fetch_icons(mapping, images_dir, write):
    """Download missing icons. Returns the ids that could not be fetched."""
    wanted = sorted({i for ids in mapping.values() for i in ids if i})
    todo = [i for i in wanted if not webp_on_disk(images_dir / f"{i}.webp")]
    print("icons: %d wanted, %d to download%s" % (len(wanted), len(todo), "" if write else " (dry run)"))
    failed = set()
    if not write or not todo:
        return failed

    images_dir.mkdir(parents=True, exist_ok=True)
    for start in range(0, len(todo), BATCH):
        batch = todo[start : start + BATCH]
        try:
            meta = get_json(THUMBS % ",".join(batch))["data"]
        except Exception as error:
            print("icon batch at %d failed (%s); will retry next run" % (start, error), file=sys.stderr)
            failed.update(batch)
            continue
        seen = set()
        for item in meta:
            target = str(item.get("targetId"))
            seen.add(target)
            url = item.get("imageUrl") or ""
            # Blocked assets resolve to a generic placeholder, which is not the pet.
            if item.get("state") != "Completed" or not url or "UnapprovedImage" in url:
                failed.add(target)
                continue
            try:
                data = get(url)
            except Exception as error:
                print("download of %s failed (%s)" % (target, error), file=sys.stderr)
                failed.add(target)
                continue
            if not is_png(data):
                print("download of %s was not a complete PNG; skipped" % target, file=sys.stderr)
                failed.add(target)
                continue
            write_atomic(images_dir / f"{target}.webp", to_webp(data))
        failed.update(i for i in batch if i not in seen)
        time.sleep(0.3)
    return failed


# --------------------------------------------------------------------------- #
# safety
# --------------------------------------------------------------------------- #

def check_untouched(before, after):
    """Return a list of problems; empty means only allowed changes were made.

    Allowed: pets appended at the end of a tab, and a blank `clicks` filled in.
    """
    problems = []
    if [c["id"] for c in before["categories"]] != [c["id"] for c in after["categories"]]:
        problems.append("the tab list or its order changed")
        return problems
    for key in before:
        if key != "categories" and before[key] != after.get(key):
            problems.append("top-level %r changed" % key)
    for old, new in zip(before["categories"], after["categories"]):
        if {k: v for k, v in old.items() if k != "pets"} != {k: v for k, v in new.items() if k != "pets"}:
            problems.append("tab %s changed" % old["id"])
        if len(new["pets"]) < len(old["pets"]):
            problems.append("tab %s lost pets" % old["id"])
            continue
        for was, now in zip(old["pets"], new["pets"]):
            if was == now:
                continue
            rest_was = {k: v for k, v in was.items() if k != "clicks"}
            rest_now = {k: v for k, v in now.items() if k != "clicks"}
            if rest_was != rest_now or was.get("clicks"):
                problems.append("%s (%s) was changed" % (was["name"], old["id"]))
    return problems


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--write", action="store_true", help="apply the changes")
    parser.add_argument("--api", help="read this saved API response instead of fetching")
    parser.add_argument("--skip-images", action="store_true", help="do not download icons or touch pet-images.json")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent.parent), help=argparse.SUPPRESS)
    args = parser.parse_args()

    root = Path(args.root)
    pets_path = root / "data" / "pets.json"
    images_json = root / "data" / "pet-images.json"
    images_dir = root / "assets" / "pets"

    try:
        body = Path(args.api).read_bytes() if args.api else get(API)
    except Exception as error:  # rate limit (429), network down, missing --api file
        print("could not read the pet list: %s" % error, file=sys.stderr)
        return 1
    entries = json.loads(body).get("entries") or {}
    if not entries:
        print("the API returned no pets; nothing done", file=sys.stderr)
        return 1
    by_name = {norm(name): entry for name, entry in entries.items()}

    raw = pets_path.read_text(encoding="utf-8")
    data = json.loads(raw)
    if json.dumps(data, indent=2, ensure_ascii=False) + "\n" != raw.replace("\r\n", "\n"):
        print("data/pets.json would be reformatted by a rewrite; stopping so nothing else changes", file=sys.stderr)
        return 1
    before = copy.deepcopy(data)

    added, skipped = find_new(data, entries, ignored_keys(root))
    filled, disagree, problems = fill_clicks(data, by_name)

    bad = check_untouched(before, data)
    if bad:
        print("refusing to continue; this would change existing data:", file=sys.stderr)
        for line in bad[:8]:
            print("  " + line, file=sys.stderr)
        if len(bad) > 8:
            print("  ... and %d more" % (len(bad) - 8), file=sys.stderr)
        return 1

    mode = "" if args.write else " (dry run, nothing written)"
    print("%d new pet(s)%s" % (len(added), mode))
    for tab, pet in added:
        print("  %-18s %-26s %-10s %-8s %s" % (tab, pet["name"], pet["rarity"], pet["clicks"] or "-", ",".join(v[0] for v in pet["variants"])))
    if added:
        print("  (egg is null and each is at the end of its tab: set the egg and move it into place)")
    if skipped:
        print("not added (%d):" % len(skipped))
        for name, reason in skipped:
            print("  %-26s %s" % (name, reason))

    new_names = {pet["name"] for _, pet in added}
    filled = [f for f in filled if f[1] not in new_names]  # new pets are listed above
    print("%d blank clicks filled on existing pets" % len(filled))
    for tab, name, value in filled:
        print("  %-18s %-26s %s" % (tab, name, value))
    for name, reason in problems:
        print("  could not fill %s: %s" % (name, reason))
    if disagree:
        print("%d existing clicks differ from the rule (left as they are):" % len(disagree))
        for name, have, expected in disagree:
            print("  %-26s has %-10s rule says %s" % (name, have, expected))

    if args.write and before != data:
        pets_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        print("wrote %s" % pets_path.relative_to(root))

    if not args.skip_images:
        try:
            previous = json.loads(images_json.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = {}
        mapping = build_mapping(data["categories"], by_name, previous)
        failed = fetch_icons(mapping, images_dir, args.write)
        if args.write:
            for ids in mapping.values():
                for position, i in enumerate(ids):
                    if i and not webp_on_disk(images_dir / f"{i}.webp"):
                        ids[position] = None
            write_atomic(images_json, json.dumps(mapping, separators=(",", ":")).encode("utf-8"))
            print("wrote %s (%d pets)" % (images_json.relative_to(root), len(mapping)))
        if failed:
            print("no usable icon (%d), retried next run: %s" % (len(failed), ", ".join(sorted(failed))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
