#!/usr/bin/env python3
"""Download pet icons and write data/pet-images.json for the grid view.

Reads the pet list from the Powerful Studio API, matches each pet in
data/pets.json by name, and fetches a 150x150 thumbnail for every image id the
API lists for it. Icons are saved as assets/pets/<asset id>.png; ids already on
disk and valid are skipped, so re-running only downloads what is new. A file that
is empty, truncated or not a PNG does not count as on disk and is fetched again.
Writes go through a temp file, so an interrupted run never leaves a partial icon
behind, and a good icon is never overwritten.

data/pet-images.json maps pet slug -> [normal, golden, toxic, galaxy] asset ids
(null where the API has none). A pet missing from the API, or whose icon cannot
be fetched, gets null for that slot and the grid shows a text tile instead. A pet
already in pet-images.json but no longer matched by name in the API (for example
after a rename here) keeps its existing entry.

Run manually:  python tools/fetch_pet_images.py
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PETS = ROOT / "data" / "pets.json"
OUT = ROOT / "data" / "pet-images.json"
IMAGES = ROOT / "assets" / "pets"

API = "https://public-api.powerfulstudio.xyz/rcu/v1/directories/pets"
THUMBS = "https://thumbnails.roblox.com/v1/assets?assetIds=%s&size=150x150&format=Png"
BATCH = 100


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_END = b"IEND\xaeB`\x82"
# HTTP statuses worth retrying; any other 4xx will not get better.
RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504}
MAX_RETRY_WAIT = 60


def is_png(data):
    """True if data is a complete-looking PNG (signature, IHDR, IEND trailer)."""
    return (
        len(data) > 33
        and data[:8] == PNG_SIGNATURE
        and data[12:16] == b"IHDR"
        and data.rstrip(b"\x00").endswith(PNG_END)
    )


def png_on_disk(path):
    """True if path is a readable, complete PNG. Empty/partial files are not."""
    try:
        return is_png(path.read_bytes())
    except OSError:
        return False


def retry_wait(error, attempt):
    """Seconds to wait before retrying: Retry-After when given, else backoff."""
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
    """Write via a temp file in the same folder, then rename into place."""
    temp = path.with_name(path.name + ".part")
    temp.write_bytes(data)
    os.replace(temp, path)


def parse_images(entry):
    """API entry -> list of asset id strings / None. Tolerates odd entries."""
    ids = []
    for raw in entry.get("images") or []:
        if raw and "://" in str(raw):
            ids.append(str(raw).split("://", 1)[1] or None)
        elif raw and str(raw).isdigit():
            ids.append(str(raw))
        else:
            ids.append(None)
    return ids


def norm(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def build_mapping(categories, by_name, previous):
    """slug -> ids. Pets the API no longer matches keep their previous entry."""
    mapping = {}
    unmatched = []
    for category in categories:
        for pet in category["pets"]:
            entry = by_name.get(norm(pet["name"]))
            if entry is None:
                unmatched.append(pet["name"])
                if pet["slug"] in previous:
                    mapping[pet["slug"]] = previous[pet["slug"]]
                continue
            ids = parse_images(entry)
            if any(ids):
                mapping[pet["slug"]] = ids
            elif pet["slug"] in previous:
                mapping[pet["slug"]] = previous[pet["slug"]]
    return mapping, unmatched


def main():
    entries = get_json(API).get("entries") or {}
    if not entries:
        print("the API returned no pets; leaving %s untouched" % OUT.name, file=sys.stderr)
        return 1
    by_name = {norm(name): entry for name, entry in entries.items()}

    categories = json.loads(PETS.read_text(encoding="utf-8"))["categories"]
    try:
        previous = json.loads(OUT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = {}
    mapping, unmatched = build_mapping(categories, by_name, previous)

    IMAGES.mkdir(parents=True, exist_ok=True)
    wanted = sorted({i for ids in mapping.values() for i in ids if i})
    todo = [i for i in wanted if not png_on_disk(IMAGES / f"{i}.png")]
    print("%d images wanted, %d to download" % (len(wanted), len(todo)))

    failed = set()
    for start in range(0, len(todo), BATCH):
        batch = todo[start : start + BATCH]
        try:
            meta = get_json(THUMBS % ",".join(batch))["data"]
        except Exception as error:
            print("batch at %d failed (%s); will retry next run" % (start, error), file=sys.stderr)
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
            write_atomic(IMAGES / f"{target}.png", data)
        failed.update(i for i in batch if i not in seen)
        time.sleep(0.3)

    for ids in mapping.values():
        for position, i in enumerate(ids):
            if i and not png_on_disk(IMAGES / f"{i}.png"):
                ids[position] = None

    write_atomic(OUT, json.dumps(mapping, separators=(",", ":")).encode("utf-8"))
    print("wrote %s (%d pets)" % (OUT.relative_to(ROOT), len(mapping)))
    if unmatched:
        print("not in the API (%d): %s" % (len(unmatched), ", ".join(unmatched)))
    if failed:
        print("no usable icon (%d): %s" % (len(failed), ", ".join(sorted(failed))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
