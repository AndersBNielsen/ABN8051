# Ultimate 8051 Assembly Guide

The companion is intentionally part of the static emulator at `guide/`, not a
parallel shop CMS guide. Its chapters and per-mnemonic descriptions live in
`site/guide/content.json`. `scripts/build-guide.py` generates the web page,
ASCII FAT16-root files, manifest and ZIP from that one source. Run the usual
`scripts/build-site.sh` after editing. The source website remains analytics-free;
iMania deployment still needs its existing private analytics overlay.

`opcodes.json` is the complete classic 256-cell encoding/timing table (A5
reserved). The initial opcode names/lengths were inventoried against the CPU
core and reviewed against the original Intel MCS-51 instruction tables. Guide
MC values are classic hardware cycles, **not a dump of interpreter timing**:
in particular ORL/ANL/XRL direct,#immediate and MOV direct,#immediate are two
cycles. Keep this reference independent of emulation approximations. All 111
operand forms and all 44 mnemonics must be represented; the browser verifier
counts rendered forms, not just source records.

The 2000-08-07 Philips shared 80C31/80C32 datasheet documents extensions in its
80C31 SFR table which the current emulator does not implement. The guide labels
these as Philips/revision-specific, explicitly notes no stocked-chip bench test,
and does not silently change the CPU emulator. The exact-production-revision
question is separate from this publishing task. WUPD is explicitly unavailable
on 80C31 in that document. Do not mistake generic 8051 claims for exact-part
verification.

ASCII files use LF (DOS/51 nano renders literal CR as `?`), only 7-bit bytes, 8.3 card filenames and <10 KB chapters.
FAT names are case-insensitive but the DOS/51 RAM disk is case-sensitive: show
`sdget guide51.txt` followed by `cat guide51.txt` (lowercase local filename).
Import one chapter at a time and remove its RAM copy when finished.

First-use cards are seeded; saved cards are never silently modified. The install
button stages all files on a copy of the image before applying changed ranges,
so a full or unsupported card fails without a partial installation. Existing
same-named files and unrelated work are preserved. Exception: byte-identical
original CRLF manual files are repaired to LF by `emu/guidefiles.js`; edited
files are never replaced. RAM copies must be removed and re-imported. Browser FAT installer is
FAT16-only even though the firmware reads FAT32 too.

Verification:

- `node --test test/dos-guide.test.js`: real firmware imports/reads every chapter,
  byte-equivalent content, duplicate additions leave card unchanged, visitor
  file preserved, first example assembles and returns.
- `node scripts/verify-guide.mjs URL`: desktop/phone, search/filter, opcode deep
  links, boot, ASCII import, installer, actual exported FAT image, persisted
  card and JavaScript errors. Uses an isolated browser profile; downloads stay
  in `/tmp`. Analytics requests are stubbed in this test; use the separate
  iMania analytics verifier for the actual overlay.
