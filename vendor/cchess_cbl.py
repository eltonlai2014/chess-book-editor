"""Canonical CBR / CBL reader for this project.

Importing this module installs the linear-formula fix for cchess's
broken CBL data-offset table (see `cbl_index_fix.py` for the bug
analysis). Use it instead of calling `cchess.Book.read_from*`
directly when reading 象棋桥 files.

    from vendor.cchess_cbl import read_cbl, read_cbr

    lib = read_cbl(path)        # {'name': str, 'games': [Book, ...]}
    book = read_cbr(path)       # Book | None
"""

from __future__ import annotations

from pathlib import Path
from typing import Union

from cchess import Book  # type: ignore[import-untyped]

from .cbl_index_fix import apply_cbl_offset_fix

apply_cbl_offset_fix()


PathLike = Union[str, Path]


def read_cbl(path: PathLike) -> dict:
    """Read a `.cbl` library and return `{'name': str, 'games': [Book, ...]}`."""
    return Book.read_from_lib(str(path))


def read_cbr(path: PathLike) -> Book | None:
    """Read a single `.cbr` game and return a `Book`, or None on bad magic."""
    return Book.read_from(str(path))
