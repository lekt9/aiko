#!/usr/bin/env python3
"""preprocess.py — one-shot KJV+xrefs → packed binary preprocessor.

Reads bible-kjv.json + cross-references.txt; emits bible.dat, bible-xrefs.dat,
bible-xrefs-idx.dat in the formats documented in SKILL.md / the bible.zig
module header.

Run once before committing. Outputs are committed; this script is a dev tool.
Not on the scripts/ allowlist — lives in libcontract/data/ as documentation.
"""
import json, struct, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
BIBLE_JSON = os.path.join(HERE, "bible-kjv.json")
XREFS_TXT  = os.path.join(HERE, "cross-references.txt")
BIBLE_DAT  = os.path.join(HERE, "bible.dat")
XREFS_DAT  = os.path.join(HERE, "bible-xrefs.dat")
IDX_DAT    = os.path.join(HERE, "bible-xrefs-idx.dat")

# Map openbible.info abbrev → KJV JSON book index (0..65).
OPENBIBLE_TO_IDX = {
    "Gen": 0, "Exod": 1, "Lev": 2, "Num": 3, "Deut": 4,
    "Josh": 5, "Judg": 6, "Ruth": 7,
    "1Sam": 8, "2Sam": 9, "1Kgs": 10, "2Kgs": 11,
    "1Chr": 12, "2Chr": 13, "Ezra": 14, "Neh": 15, "Esth": 16,
    "Job": 17, "Ps": 18, "Prov": 19, "Eccl": 20, "Song": 21,
    "Isa": 22, "Jer": 23, "Lam": 24, "Ezek": 25, "Dan": 26,
    "Hos": 27, "Joel": 28, "Amos": 29, "Obad": 30, "Jonah": 31,
    "Mic": 32, "Nah": 33, "Hab": 34, "Zeph": 35, "Hag": 36,
    "Zech": 37, "Mal": 38,
    "Matt": 39, "Mark": 40, "Luke": 41, "John": 42, "Acts": 43,
    "Rom": 44, "1Cor": 45, "2Cor": 46, "Gal": 47, "Eph": 48,
    "Phil": 49, "Col": 50, "1Thess": 51, "2Thess": 52,
    "1Tim": 53, "2Tim": 54, "Titus": 55, "Phlm": 56,
    "Heb": 57, "Jas": 58, "1Pet": 59, "2Pet": 60,
    "1John": 61, "2John": 62, "3John": 63, "Jude": 64, "Rev": 65,
}

def main():
    with open(BIBLE_JSON, "rb") as f:
        raw = f.read()
    # Strip BOM if present
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    books = json.loads(raw)
    assert len(books) == 66, f"expected 66 books, got {len(books)}"

    # ── verse_idx assignment ───────────────────────────────────────────
    # Flat 0..31099 in canonical book→chapter→verse order.
    verse_idx_of = {}   # (book_idx, chapter_1, verse_1) → flat idx
    verse_texts  = []   # parallel array of UTF-8 text strings
    book_first_verse = []
    book_chapter_first_verse = []   # list[list[u16]]

    flat = 0
    for bi, book in enumerate(books):
        book_first_verse.append(flat)
        per_chapter = []
        for ci, chap in enumerate(book["chapters"]):
            per_chapter.append(flat)
            for vi, vtext in enumerate(chap):
                verse_idx_of[(bi, ci+1, vi+1)] = flat
                verse_texts.append(vtext)
                flat += 1
        book_chapter_first_verse.append(per_chapter)
    assert flat == 31100, f"expected 31100 verses, got {flat}"
    verse_count = flat

    # ── string pool (book names + abbrevs) ─────────────────────────────
    pool = bytearray()
    name_offsets = []
    abbrev_offsets = []
    # openbible abbrevs by index (reverse map)
    abbrev_by_idx = {v: k for k, v in OPENBIBLE_TO_IDX.items()}
    for bi, book in enumerate(books):
        name = book["name"].encode("utf-8")
        ab = abbrev_by_idx[bi].encode("utf-8")
        name_offsets.append(len(pool))
        pool.extend(name); pool.append(0)
        abbrev_offsets.append(len(pool))
        pool.extend(ab); pool.append(0)

    # ── text blob + verse offsets ──────────────────────────────────────
    text_blob = bytearray()
    verse_offsets = []  # length verse_count+1
    for txt in verse_texts:
        verse_offsets.append(len(text_blob))
        text_blob.extend(txt.encode("utf-8"))
    verse_offsets.append(len(text_blob))

    # ── pack bible.dat ─────────────────────────────────────────────────
    out = bytearray()
    out += struct.pack("<II", verse_count, len(books))
    # Book table: 66 × { u16 name_off, u16 abbrev_off, u16 first_verse_idx, u16 chapter_count }
    for bi in range(len(books)):
        out += struct.pack("<HHHH",
            name_offsets[bi], abbrev_offsets[bi],
            book_first_verse[bi], len(books[bi]["chapters"]))
    # Chapter table: per book, [u16 first_verse_idx_of_chapter; chapter_count]
    for bi in range(len(books)):
        for fv in book_chapter_first_verse[bi]:
            out += struct.pack("<H", fv)
    # Verse offset table: [u32 ; verse_count+1]
    for off in verse_offsets:
        out += struct.pack("<I", off)
    # String pool length + pool
    out += struct.pack("<I", len(pool))
    out += pool
    # Text blob length + blob
    out += struct.pack("<I", len(text_blob))
    out += text_blob

    with open(BIBLE_DAT, "wb") as f:
        f.write(out)

    # ── parse cross-references ─────────────────────────────────────────
    def resolve_ref(ref):
        # "Book.Chapter.Verse" → flat idx, or None
        try:
            book, ch, vs = ref.split(".")
            bi = OPENBIBLE_TO_IDX.get(book)
            if bi is None:
                return None, book
            ch = int(ch); vs = int(vs)
            return verse_idx_of.get((bi, ch, vs)), book
        except Exception:
            return None, ref

    edges = []  # list of (from_idx, to_start_idx, to_end_idx, votes)
    skipped = 0
    skipped_books = {}
    with open(XREFS_TXT) as f:
        header = f.readline()
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            from_ref, to_ref, votes_s = parts[0], parts[1], parts[2]
            from_idx, from_book = resolve_ref(from_ref)
            if from_idx is None:
                skipped += 1
                skipped_books[from_book] = skipped_books.get(from_book, 0) + 1
                continue
            # to_ref can be a range "Book.Ch.V-Book.Ch.V"
            if "-" in to_ref:
                lo, hi = to_ref.split("-", 1)
                lo_idx, lo_book = resolve_ref(lo)
                hi_idx, hi_book = resolve_ref(hi)
                if lo_idx is None or hi_idx is None:
                    skipped += 1
                    skipped_books[lo_book] = skipped_books.get(lo_book, 0) + 1
                    continue
                to_start, to_end = lo_idx, hi_idx
            else:
                to_idx, to_book = resolve_ref(to_ref)
                if to_idx is None:
                    skipped += 1
                    skipped_books[to_book] = skipped_books.get(to_book, 0) + 1
                    continue
                to_start = to_end = to_idx
            try:
                votes = int(votes_s)
            except ValueError:
                votes = 0
            # Clamp votes to u16
            if votes < 0: votes = 0
            if votes > 65535: votes = 65535
            # Clamp indices to u16 (verse_count = 31100 < 65536, OK)
            edges.append((from_idx, to_start, to_end, votes))

    # Sort by from_idx so the per-verse index can binary-search/range over them.
    edges.sort(key=lambda e: e[0])

    # ── pack bible-xrefs.dat ───────────────────────────────────────────
    xout = bytearray()
    xout += struct.pack("<I", len(edges))
    for fi, ts, te, vt in edges:
        xout += struct.pack("<HHHH", fi, ts, te, vt)
    with open(XREFS_DAT, "wb") as f:
        f.write(xout)

    # ── pack bible-xrefs-idx.dat ───────────────────────────────────────
    # idx[i] = offset (in edges) of first edge with from_verse_idx == i.
    # idx has verse_count+1 entries; idx[verse_count] = len(edges).
    idx = [0] * (verse_count + 1)
    cur = 0
    for v in range(verse_count):
        while cur < len(edges) and edges[cur][0] < v:
            cur += 1
        idx[v] = cur
    idx[verse_count] = len(edges)

    iout = bytearray()
    for off in idx:
        iout += struct.pack("<I", off)
    with open(IDX_DAT, "wb") as f:
        f.write(iout)

    # ── report ─────────────────────────────────────────────────────────
    print(f"bible.dat        : {len(out):,} bytes  ({verse_count} verses, {len(books)} books)")
    print(f"bible-xrefs.dat  : {len(xout):,} bytes  ({len(edges):,} edges)")
    print(f"bible-xrefs-idx.dat: {len(iout):,} bytes  ({verse_count+1} entries)")
    print(f"skipped edges    : {skipped}")
    if skipped_books:
        print(f"skipped by abbrev: {skipped_books}")

if __name__ == "__main__":
    main()
