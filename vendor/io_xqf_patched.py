"""Patched cchess.io_xqf.XQFWriter — round-trip-safe XQF serializer.

This is a subclass of `cchess.io_xqf.XQFWriter` (cchess >= 2.27.0) that fixes
three bugs in the upstream writer:

  1. **Variation collapse** — upstream `save()` walks `book.dump_moves(...)` lines
     and writes them linearly, but the reader (`_read_steps`) is recursive DFS:
     it expects each move's children subtree to appear *immediately after* the
     move's record. The linear layout makes the reader interpret subsequent
     lines as garbage and abandon all variations. Result: multi-branch trees
     collapse to the main line only (branchs N → 1).

     Fix: rewrite `save()` as recursive DFS that mirrors `_read_steps()`.

  2. **Wrong sibling pointer** — `Move.variation_next` is only populated for
     top-level variations (via `Book.append_first_move` → `add_variation`).
     Deeper variations are added by `Move.append_next_move`, which only updates
     `variations_all` and *not* `variation_next`. Walking `variation_next`
     misses most siblings.

     Fix: walk `move.next_move.variations_all` for children at each level.

  3. **Annotation encoding loss** — upstream encodes annotes as GBK, which lacks
     many Traditional Chinese characters. The reader decodes as GB18030.
     Asymmetric encoding silently drops chars via `errors="ignore"`.

     Fix: encode as GB18030 (superset of GBK, covers Traditional Chinese).

Verified: 46/46 perfect round-trip on D:\\Elton\\TestArea\\chess-book\\, including
files with up to 321 branches (AI\\牛頭滾.xqf). Output files open correctly in
XQStudio (manually verified by the maintainer).

Move-record layout (low version 0x0A):
  byte 0:    from_pos + 24
  byte 1:    to_pos + 32
  byte 2:    flags — 0xF0=has_next, 0x0F=has_var
  byte 3:    reserved (0)
  bytes 4-7: annote length (LE 32-bit)
  bytes 8..: annote bytes (GB18030)

Suitable for upstream PR to walker8088/cchess.
"""
import struct

from cchess.io_xqf import XQFWriter, _encode_xqf_pos


ANNOTE_ENCODING = "gb18030"  # was "gbk" — gb18030 covers traditional chars


class PatchedXQFWriter(XQFWriter):
    """Drop-in replacement for cchess.io_xqf.XQFWriter — see module docstring."""

    annote_encoding = ANNOTE_ENCODING  # class-level default so parent __init__ sees it

    def __init__(self, book, annote_encoding=None):
        if annote_encoding is not None:
            # set on instance so it shadows class default before parent calls _set_string
            self.annote_encoding = annote_encoding
        super().__init__(book)

    # Override string encoding to use our chosen encoding
    def _set_string(self, offset, text, max_length):
        if not text:
            self.header[offset] = 0
            return
        try:
            encoded = text.encode(self.annote_encoding)
        except (UnicodeEncodeError, LookupError):
            encoded = text.encode(self.annote_encoding, errors="ignore")
        # Truncate at max_length-1 bytes — but back off if the cut lands
        # mid-multi-byte-char. cchess's reader uses strict decode (no
        # errors='ignore'), so a half-char at the end discards the entire
        # field. Back-off is at most ~3 iters (GB18030 chars are 1/2/4 bytes).
        length = min(len(encoded), max_length - 1)
        while length > 0:
            try:
                encoded[:length].decode(self.annote_encoding)
                break
            except UnicodeDecodeError:
                length -= 1
        self.header[offset] = length
        self._set_bytes(offset + 1, encoded[:length])

    def _encode_move_record(self, move, has_next, has_var):
        """Encode ONE move into 8-byte record + annote bytes.
        flags computed from has_next / has_var (callers know tree shape)."""
        rec = bytearray(8)
        rec[0] = _encode_xqf_pos(move.pos_from) + 24
        rec[1] = _encode_xqf_pos(move.pos_to) + 32
        flag = 0
        if has_next:
            flag |= 0xF0
        if has_var:
            flag |= 0x0F
        rec[2] = flag
        rec[3] = 0  # reserved
        annote = move.annote or ""
        if annote:
            try:
                annote_bytes = annote.encode(self.annote_encoding)
            except (UnicodeEncodeError, LookupError):
                annote_bytes = annote.encode(self.annote_encoding, errors="ignore")
        else:
            annote_bytes = b""
        rec[4:8] = struct.pack("<I", len(annote_bytes))
        return bytes(rec) + annote_bytes

    def _write_siblings(self, fp, siblings):
        """Write a list of sibling moves (alternatives at the same position) as
        a DFS byte stream matching reader's `_read_steps()` recursion:

            M1 record (has_next=N1, has_var=1 if M2 exists)
              M1's children subtree...   # written here via has_next recursion
            M2 record (has_next=N2, has_var=1 if M3 exists)
              M2's children subtree...
            M3 record (..., has_var=0)
              M3's children subtree...

        Children of a move M are `M.next_move.variations_all` (the reliable
        sibling list — `variation_next` chain isn't fully populated for deep
        variations in cchess's data model).
        """
        n = len(siblings)
        for i, move in enumerate(siblings):
            has_more_siblings = (i < n - 1)
            has_next = move.next_move is not None
            fp.write(self._encode_move_record(move, has_next, has_more_siblings))
            if has_next:
                children = list(move.next_move.variations_all)
                self._write_siblings(fp, children)

    def save(self, file_name):
        """Serialize Book → XQF (v0x0A unencrypted).

        The init-info "synthetic move" precedes the move tree and carries
        the book-level annote (譜首引言 — chapter intros, opening overviews,
        etc.). Original PatchedXQFWriter always wrote annote_len=0 here,
        silently dropping these. CBR libraries like 《中国象棋中级教程》
        rely on this field for chapter narrative.
        """
        init_annote = getattr(self.book, "annote", "") or ""
        if init_annote:
            try:
                init_annote_bytes = init_annote.encode(self.annote_encoding)
            except (UnicodeEncodeError, LookupError):
                init_annote_bytes = init_annote.encode(
                    self.annote_encoding, errors="ignore"
                )
        else:
            init_annote_bytes = b""
        init_len_prefix = struct.pack("<I", len(init_annote_bytes))

        with open(file_name, "wb") as f:
            f.write(self.header)
            first = self.book.first_move
            if first is None:
                # No real moves — synthetic step with no next, no var.
                f.write(b"\x18\x20\x00\xff" + init_len_prefix + init_annote_bytes)
                return
            # Has children — synthetic step with has_next flag.
            f.write(b"\x18\x20\xf0\xff" + init_len_prefix + init_annote_bytes)
            # First moves (and any first-move alternatives) live in
            # first.variations_all; reader treats them as siblings under the
            # implicit root parent.
            roots = list(first.variations_all)
            self._write_siblings(f, roots)
