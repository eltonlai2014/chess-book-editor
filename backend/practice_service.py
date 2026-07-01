"""中局練習題庫的抽題管線 + practice.db（P0）。

從 CCBridge CBL 書庫（殺法/戰術/中局…）抽出「中局練習題」，寫進編輯器自有的
writable ``output/practice.db``：每題 = 一個自訂中局盤面 ``init_fen`` ＋ 一條答案
主線 ``answer`` ＋ 講解。可選引擎複核（Pikafish 跑 ``init_fen``，記 ``engine_best``
與 ``ok/存疑`` 判定）。

題目模型（已驗證）：CBL 一局 = ``cb_service.load_cb`` 的
``{info, init_fen, init_annote, roots}``。答案主線 = 沿每個節點的第一個 child 走到
底的 ``iccs``/中文 序列；解題方 = ``init_fen`` 的走子方（``w``=紅、``b``=黑）。

唯讀於來源 CBL（books are read-only）；``practice.db`` 是本模組**唯一寫入**的題庫，
與 ``eval_cache`` / 編輯器 chessdb cache 平行（皆編輯器自有 ``output/``）。引擎仲裁
的 eval 也回寫進共用的 ``editor_eval_cache.db``（同 depth 鍵），所以重跑仲裁免費。

**題庫共享靠版控 seed（不是把 practice.db 進 git）。** 語料 CBL 與 ``practice.db``
都不在 git（``output/`` gitignore），所以其他主機無法自行抽題。改把 ``puzzles``
匯出成 ``data/practice_seed.db``（進 git、只題庫、不含作答/進度），其他主機 git pull
後由 ``pooled()`` 首次啟動自動灌入（本機 practice.db 無題時）——UI 入口才亮。作答/
複習進度仍各機獨立（不進 seed，不互蓋）。重抽題庫後跑 ``export-seed`` 更新 seed 再 commit。

CLI（離線批次）::

    # 抽題（單檔或整個資料夾遞迴）＋引擎仲裁
    python -m backend.practice_service extract <book.cbl 或 資料夾> [--depth 12]
    python -m backend.practice_service extract <...> --no-engine   # 只抽題、不跑引擎
    python -m backend.practice_service arbitrate [--depth 12]      # 補跑既有未複核題
    python -m backend.practice_service stats                       # 看題庫統計
    python -m backend.practice_service export-seed                 # 題庫→版控 seed（進 git）
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

# 允許「python -m backend.practice_service」與「python backend/practice_service.py」兩種跑法。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import config  # noqa: E402
from backend.cb_service import list_cbl_games, load_cb  # noqa: E402

try:
    import cchess  # noqa: E402
    _STD_BOARD = cchess.FULL_INIT_FEN.split()[0]
except Exception:  # pragma: no cover - cchess 必在，保險用
    _STD_BOARD = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR"

# 題庫 DB：編輯器自有、可寫，與 eval_cache 同住 output/（gitignore，本機各自作答）。
PRACTICE_DB_PATH = config._data_base() / "output" / "practice.db"
# 題庫 SEED：**版控**的唯讀種子（只含 puzzles，不含作答/進度），跟著 repo 走，讓
# 其他主機 git pull 後免抽即用。首次啟動（本機 practice.db 無題）由 pooled() 自動
# 灌入。語料 CBL 與 practice.db 都不在 git，所以「共享題庫」靠這顆 seed；作答/複習
# 進度仍各機獨立（不進 seed）。用 _resource_base()：source run=repo 根、frozen=_MEIPASS
# （server.spec 的 datas 已帶 data/）。重抽後用 CLI `export-seed` 重新產生。
PRACTICE_SEED_PATH = config._resource_base() / "data" / "practice_seed.db"

# 抽題門檻。答案主線少於這麼多 ply 視為「瑣碎一手/類目佔位」濾掉；可由 CLI 調。
DEFAULT_MIN_PLY = 2
# 仲裁：解題方 cp（自己視角）≥ 此值才算「明顯佔優」，據以把 engine_best≠書答 的題
# 從「doubt（存疑）」升級為「alt（引擎走別著但仍勝勢，書答可接受）」。
_WIN_CP = 300

_SCHEMA = """
CREATE TABLE IF NOT EXISTS puzzles (
  id             INTEGER PRIMARY KEY,
  source_rel     TEXT    NOT NULL,   -- 來源檔（相對 books root），CBL 同檔多盤
  game_index     INTEGER NOT NULL,   -- CBL 內 0-based 盤序（CBR=0）
  init_fen       TEXT    NOT NULL,   -- 自訂中局盤面 <board> <side>
  side           TEXT    NOT NULL,   -- 解題方：'w'(紅) / 'b'(黑)
  answer_iccs    TEXT    NOT NULL,   -- JSON list[str]：答案主線 UCI
  answer_zh      TEXT    NOT NULL,   -- JSON list[str]：答案主線中文著法
  commentary     TEXT,               -- init_annote + 節點註解（換行接）
  category       TEXT,               -- 由標題抽出的類目（如「十八、车马炮类」）
  title          TEXT,               -- 該盤清理後的完整標題
  book_title     TEXT,               -- 書名（CBL 檔名 stem）
  book_author    TEXT,               -- 作者（檔名啟發式拆出，可空）
  ply_count      INTEGER NOT NULL,   -- 答案主線 ply 數
  engine_best    TEXT,               -- 引擎最佳著 UCI（紅 POV 無關，UCI 本身）
  engine_cp      INTEGER,            -- 引擎分（紅 POV）
  engine_mate    INTEGER,            -- 引擎殺步（紅 POV，>0 紅勝）
  engine_verdict TEXT,               -- 'match' / 'alt' / 'doubt'（NULL=未複核）
  difficulty     INTEGER,            -- 1..5 簡易難度帶（先依 ply 數）
  created_at     TEXT,
  UNIQUE(source_rel, game_index)
);
CREATE TABLE IF NOT EXISTS attempts (
  id        INTEGER PRIMARY KEY,
  puzzle_id INTEGER NOT NULL,
  ts        TEXT    NOT NULL,
  result    TEXT    NOT NULL,   -- 'pass' / 'fail'
  user_iccs TEXT,               -- 使用者所走（JSON list 或單著）
  time_ms   INTEGER,
  FOREIGN KEY(puzzle_id) REFERENCES puzzles(id)
);
CREATE TABLE IF NOT EXISTS progress (
  puzzle_id      INTEGER PRIMARY KEY,
  state          TEXT    NOT NULL DEFAULT 'new',  -- new/learning/review/mastered
  fails          INTEGER NOT NULL DEFAULT 0,
  next_review_ts TEXT,
  FOREIGN KEY(puzzle_id) REFERENCES puzzles(id)
);
CREATE INDEX IF NOT EXISTS ix_puzzles_book ON puzzles(book_title);
CREATE INDEX IF NOT EXISTS ix_puzzles_difficulty ON puzzles(difficulty);
CREATE INDEX IF NOT EXISTS ix_puzzles_verdict ON puzzles(engine_verdict);
"""


# ---------- DB ---------------------------------------------------------------

def connect(db_path: Path = PRACTICE_DB_PATH) -> sqlite3.Connection:
    """開（並按需建表）practice.db，回 row_factory=Row 的連線。呼叫端負責 close。

    **不自動灌 seed**——CLI 的抽題/仲裁/匯出走這條，得看到「本機真實內容」（空就是空、
    才好重抽）。seed 載入只發生在 Flask serving 的 ``pooled()``（見那裡）。
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    con.executescript(_SCHEMA)
    con.commit()
    return con


def _seed_puzzles_if_empty(con: sqlite3.Connection,
                           seed_path: Path | None = None) -> int:
    """本機 puzzles 為空且版控 seed 存在時，把 seed 的題庫灌進來；回灌入題數（否則 0）。

    只灌 ``puzzles``（作答/進度各機獨立、不在 seed）。ATTACH 來源檔、``INSERT … SELECT
    *``——seed 是同 ``_SCHEMA`` 匯出，欄位對齊。給其他主機「pull 完就有題」用；本機已有
    題（重抽過）則原封不動。
    """
    seed_path = seed_path if seed_path is not None else PRACTICE_SEED_PATH
    try:
        if con.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0] > 0:
            return 0
    except sqlite3.Error:
        return 0
    if not seed_path.exists():
        return 0
    con.execute("ATTACH DATABASE ? AS seed", (str(seed_path),))
    try:
        con.execute("INSERT INTO puzzles SELECT * FROM seed.puzzles")
        con.commit()
        return con.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0]
    finally:
        con.execute("DETACH DATABASE seed")


def export_seed(con: sqlite3.Connection,
                seed_path: Path | None = None) -> int:
    """把 ``con`` 的 ``puzzles`` 匯出成版控 seed（只題庫、不含作答/進度）；回題數。

    從**既有連線**讀列、寫進新 seed db——不對 practice.db 二次開檔（避免與跑著的
    server 的 WAL 鎖相撞）。seed 是完整 ``_SCHEMA`` 的獨立 db（attempts/progress 表
    存在但空），本身也是合法的「空作答」practice.db。重抽後跑 CLI ``export-seed``
    更新它再 commit。
    """
    seed_path = seed_path if seed_path is not None else PRACTICE_SEED_PATH
    seed_path.parent.mkdir(parents=True, exist_ok=True)
    cur = con.execute("SELECT * FROM puzzles")
    cols = [d[0] for d in cur.description]
    rows = [tuple(r) for r in cur.fetchall()]
    if seed_path.exists():
        seed_path.unlink()
    dst = sqlite3.connect(str(seed_path))
    try:
        dst.executescript(_SCHEMA)
        placeholders = ",".join("?" * len(cols))
        dst.executemany(
            f"INSERT INTO puzzles ({','.join(cols)}) VALUES ({placeholders})", rows)
        dst.commit()
        return dst.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0]
    finally:
        dst.close()


# ---------- 抽題輔助 ----------------------------------------------------------

def _mainline(roots: list[dict]) -> tuple[list[str], list[str], list[str]]:
    """沿 roots[0] 的第一個 child 走到底，回 (iccs, 中文, 節點註解)。

    答案主線取「每步第一個 child」——CBL 殺法/中局題的主線即正解，旁支是變著。
    """
    iccs: list[str] = []
    zh: list[str] = []
    notes: list[str] = []
    node = roots[0] if roots else None
    while node is not None:
        mv = node.get("iccs")
        if mv:
            iccs.append(mv)
            zh.append(node.get("notation") or "")
        an = (node.get("annote") or "").strip()
        if an:
            notes.append(an)
        children = node.get("children") or []
        node = children[0] if children else None
    return iccs, zh, notes


_CATEGORY_RE = re.compile(r"[一二三四五六七八九十百]+、[^\s]+?[类類]")


def _parse_title(title: str) -> tuple[str, str]:
    """(category, clean_title)。category = 標題中的「…类」類目段（抓不到回 ""）。

    標題形如「301  十八、车马炮类  第30局」。清理 = strip + 壓多空白為單空白。
    """
    clean = re.sub(r"\s+", " ", (title or "").strip())
    m = _CATEGORY_RE.search(clean)
    return (m.group(0) if m else ""), clean


def _book_meta(cbl_path: Path) -> tuple[str, str]:
    """(book_title, book_author)。書名 = 檔名 stem；作者啟發式從 stem 末段拆。

    CCBridge 檔名常見「書名--作者」「書名_作者」「書名—作者」；拆不出作者回 ""。
    """
    stem = cbl_path.stem
    for sep in ("--", "—", "－－"):
        if sep in stem:
            left, right = stem.rsplit(sep, 1)
            return left.strip(" -_"), right.strip(" -_")
    return stem, ""


def _difficulty(ply_count: int) -> int:
    """答案主線 → 1..5 placeholder 難度帶（解題方著數＝半 ply）。

    抽題時的初值；引擎仲裁見殺時改用殺步距離 refine（見 ``arbitrate``）——殺步距離
    比書答主線長度更貼切（主線含對手回應，且常多列幾步收官）。Glicko-2 後期再上。
    """
    solver_moves = (ply_count + 1) // 2
    return max(1, min(5, solver_moves))


def _mate_difficulty(mover_mate: int) -> int:
    """解題方 mate-in-N → N★（capped 1..5）。引擎仲裁見殺時的難度信號。"""
    return max(1, min(5, abs(mover_mate)))


def _is_standard_start(init_fen: str) -> bool:
    return (init_fen or "").split()[:1] == [_STD_BOARD]


def build_puzzle(data: dict, source_rel: str, game_index: int,
                 book_title: str, book_author: str,
                 min_ply: int = DEFAULT_MIN_PLY) -> tuple[dict | None, str]:
    """單局 JSON → (puzzle dict | None, skip 原因)。None 代表被濾掉（原因見字串）。"""
    init_fen = (data.get("init_fen") or "").strip()
    if not init_fen:
        return None, "no-fen"
    roots = data.get("roots") or []
    iccs, zh, notes = _mainline(roots)
    if not iccs:
        return None, "no-answer"
    if len(iccs) < min_ply:
        return None, f"too-short({len(iccs)})"
    if _is_standard_start(init_fen):
        return None, "opening-start"

    info = data.get("info") or {}
    category, clean_title = _parse_title(info.get("title", ""))
    side = init_fen.split()[1] if len(init_fen.split()) > 1 else "w"
    commentary_parts = []
    if (data.get("init_annote") or "").strip():
        commentary_parts.append(data["init_annote"].strip())
    commentary_parts.extend(notes)
    commentary = "\n".join(commentary_parts)

    puzzle = {
        "source_rel": source_rel,
        "game_index": game_index,
        "init_fen": init_fen,
        "side": side,
        "answer_iccs": json.dumps(iccs, ensure_ascii=False),
        "answer_zh": json.dumps(zh, ensure_ascii=False),
        "commentary": commentary,
        "category": category,
        "title": clean_title,
        "book_title": book_title,
        "book_author": book_author,
        "ply_count": len(iccs),
        "difficulty": _difficulty(len(iccs)),
    }
    return puzzle, "ok"


# ---------- 抽題（單檔 / 資料夾） ---------------------------------------------

def _rel_to_root(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def extract_cbl(con: sqlite3.Connection, cbl_path: Path, root: Path,
                min_ply: int = DEFAULT_MIN_PLY) -> dict:
    """抽一個 .cbl 的所有盤進 puzzles（UPSERT），回統計 {added, skipped, reasons}。"""
    source_rel = _rel_to_root(cbl_path, root)
    book_title, book_author = _book_meta(cbl_path)
    games = list_cbl_games(cbl_path)
    stats = {"file": cbl_path.name, "games": len(games), "added": 0,
             "skipped": 0, "reasons": {}}
    for g in games:
        idx = g["index"]
        try:
            data = load_cb(cbl_path, idx)
        except Exception as e:
            stats["skipped"] += 1
            stats["reasons"]["load-error"] = stats["reasons"].get("load-error", 0) + 1
            continue
        puzzle, reason = build_puzzle(data, source_rel, idx, book_title,
                                      book_author, min_ply=min_ply)
        if puzzle is None:
            stats["skipped"] += 1
            stats["reasons"][reason] = stats["reasons"].get(reason, 0) + 1
            continue
        _upsert_puzzle(con, puzzle)
        stats["added"] += 1
    con.commit()
    return stats


def _upsert_puzzle(con: sqlite3.Connection, p: dict) -> None:
    """依 (source_rel, game_index) UPSERT；重抽不重複、且不抹掉既有引擎複核欄位。"""
    con.execute(
        """
        INSERT INTO puzzles
            (source_rel, game_index, init_fen, side, answer_iccs, answer_zh,
             commentary, category, title, book_title, book_author, ply_count,
             difficulty, created_at)
        VALUES
            (:source_rel, :game_index, :init_fen, :side, :answer_iccs, :answer_zh,
             :commentary, :category, :title, :book_title, :book_author, :ply_count,
             :difficulty, :created_at)
        ON CONFLICT(source_rel, game_index) DO UPDATE SET
            init_fen=excluded.init_fen, side=excluded.side,
            answer_iccs=excluded.answer_iccs, answer_zh=excluded.answer_zh,
            commentary=excluded.commentary, category=excluded.category,
            title=excluded.title, book_title=excluded.book_title,
            book_author=excluded.book_author, ply_count=excluded.ply_count,
            difficulty=excluded.difficulty
        """,
        {**p, "created_at": p.get("created_at") or _now()},
    )


def extract_path(con: sqlite3.Connection, target: Path, root: Path | None = None,
                 min_ply: int = DEFAULT_MIN_PLY) -> list[dict]:
    """抽單檔或整個資料夾（遞迴所有 .cbl）。回每檔統計清單。"""
    if root is None:
        root = target if target.is_dir() else target.parent
    if target.is_file():
        cbls = [target]
    else:
        cbls = sorted(p for p in target.rglob("*") if p.suffix.lower() == ".cbl")
    out = []
    for cbl in cbls:
        try:
            out.append(extract_cbl(con, cbl, root, min_ply=min_ply))
        except Exception as e:
            out.append({"file": cbl.name, "error": str(e)})
    return out


# ---------- 引擎仲裁 ----------------------------------------------------------

def arbitrate(con: sqlite3.Connection, engine_path: Path, depth: int = 12,
              limit: int | None = None, fresh: bool = False) -> dict:
    """對尚未複核（或 fresh=全部）的題跑 Pikafish，記 engine_best/cp/mate/verdict。

    一支引擎程序跑完整批（複用 ``engine_service.analyze_line_stream`` 的單引擎掃描），
    eval 同時回寫共用 ``editor_eval_cache.db``（同 depth 鍵），重跑仲裁免費。

    verdict：
      - ``match``  引擎最佳著 == 書答首著
      - ``alt``    首著不同，但解題方明顯勝勢（引擎見殺 mate>0，或自己視角 cp≥門檻）
                   → 書答屬等值正解之一（落子評分時再用引擎等值認定）
      - ``doubt``  引擎不認為解題方勝勢 → 書答/盤面存疑
    """
    from backend import engine_service  # 延後 import，避免無引擎環境載入成本

    where = "" if fresh else "WHERE engine_verdict IS NULL"
    sql = f"SELECT id, init_fen, side, answer_iccs FROM puzzles {where} ORDER BY id"
    if limit:
        sql += f" LIMIT {int(limit)}"
    rows = con.execute(sql).fetchall()
    if not rows:
        return {"arbitrated": 0, "verdicts": {}}

    fens = [r["init_fen"] for r in rows]
    records = []
    for line in engine_service.analyze_line_stream(
            engine_path, fens, depth, 0,
            cache_path=config.EVAL_CACHE_PATH, fresh=fresh):
        records.append(json.loads(line))
    # records 與 fens 同序（analyze_line_stream 逐 fen yield）。
    by_ply = {rec["ply"]: rec for rec in records}

    verdicts: dict[str, int] = {}
    for i, row in enumerate(rows):
        rec = by_ply.get(i)
        if rec is None:
            continue
        best = rec.get("best")
        cp = rec.get("cp")
        mate = rec.get("mate")
        answer = json.loads(row["answer_iccs"])
        answer_first = answer[0] if answer else None
        verdict = _verdict(best, cp, mate, row["side"], answer_first)
        verdicts[verdict] = verdicts.get(verdict, 0) + 1
        # 見殺（解題方視角 mate>0）→ 用殺步距離 refine 難度，蓋過 ply placeholder。
        sign = 1 if row["side"] == "w" else -1
        mover_mate = (mate * sign) if mate is not None else None
        diff = _mate_difficulty(mover_mate) if (mover_mate and mover_mate > 0) else None
        if diff is not None:
            con.execute(
                "UPDATE puzzles SET engine_best=?, engine_cp=?, engine_mate=?,"
                " engine_verdict=?, difficulty=? WHERE id=?",
                (best, cp, mate, verdict, diff, row["id"]),
            )
        else:
            con.execute(
                "UPDATE puzzles SET engine_best=?, engine_cp=?, engine_mate=?,"
                " engine_verdict=? WHERE id=?",
                (best, cp, mate, verdict, row["id"]),
            )
    con.commit()
    return {"arbitrated": len(rows), "verdicts": verdicts}


def _verdict(best: str | None, cp: int | None, mate: int | None,
             side: str, answer_first: str | None) -> str:
    if best and answer_first and best == answer_first:
        return "match"
    # 解題方視角：紅 POV → 自己視角要對黑翻號。
    sign = 1 if side == "w" else -1
    mover_mate = (mate * sign) if mate is not None else None
    mover_cp = (cp * sign) if cp is not None else None
    if (mover_mate is not None and mover_mate > 0) or \
       (mover_cp is not None and mover_cp >= _WIN_CP):
        return "alt"
    return "doubt"


# ---------- 路由用：池化連線 + 抽題 + 評分 + 間隔重練 ------------------------
#
# CLI 用 connect()（自有連線、自行 close）；Flask 用 pooled()（程序級池化，勿 close）。
# 評分用「已存的 engine_best」判引擎等值——免每次開引擎，已仲裁的題秒回。

_pooled_inited: set[str] = set()


def pooled(db_path: Path | None = None) -> sqlite3.Connection:
    """Flask 用的程序級池化可寫連線（db_pool，WAL）；首次建表。**勿 close**。

    晚綁 ``PRACTICE_DB_PATH``（不在簽名預設綁死）——測試可改 module 變數重導向。
    """
    from backend import db_pool
    db_path = db_path or PRACTICE_DB_PATH
    con = db_pool.get_rw(db_path)
    key = str(db_path)
    if key not in _pooled_inited:
        con.executescript(_SCHEMA)
        con.commit()
        # 其他主機首次啟動：本機 practice.db 無題 → 從版控 seed 灌題庫，UI 入口才亮。
        _seed_puzzles_if_empty(con)
        _pooled_inited.add(key)
    return con


def practice_info(con: sqlite3.Connection) -> dict:
    """題庫總覽（gate UI 入口）：題數、已仲裁數、難度分布、書目清單。"""
    total = con.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0]
    arbitrated = con.execute(
        "SELECT COUNT(*) FROM puzzles WHERE engine_verdict IS NOT NULL").fetchone()[0]
    by_diff = {int(k): v for k, v in con.execute(
        "SELECT difficulty, COUNT(*) FROM puzzles GROUP BY difficulty").fetchall()}
    books = [{"book": r[0], "count": r[1]} for r in con.execute(
        "SELECT book_title, COUNT(*) c FROM puzzles GROUP BY book_title"
        " ORDER BY c DESC").fetchall()]
    return {"exists": total > 0, "total": total, "arbitrated": arbitrated,
            "by_difficulty": by_diff, "books": books}


def _filters(book, difficulty, exclude_doubt) -> tuple[str, list]:
    where, params = [], []
    if book:
        where.append("p.book_title = ?"); params.append(book)
    if difficulty:
        where.append("p.difficulty = ?"); params.append(int(difficulty))
    if exclude_doubt:
        where.append("(p.engine_verdict IS NULL OR p.engine_verdict != 'doubt')")
    return ((" AND " + " AND ".join(where)) if where else ""), params


def pick_puzzle(con: sqlite3.Connection, book: str | None = None,
                difficulty: int | None = None, exclude_doubt: bool = True) -> dict | None:
    """抽一題：① 到期複習（progress.next_review_ts ≤ now，最舊優先）→ ② 新題
    （無 progress，隨機）→ ③ 任一符合（隨機）。預設排除 doubt 題。"""
    wsql, params = _filters(book, difficulty, exclude_doubt)
    now = _now()
    row = con.execute(
        f"SELECT p.* FROM puzzles p JOIN progress g ON g.puzzle_id = p.id"
        f" WHERE g.next_review_ts IS NOT NULL AND g.next_review_ts <= ?{wsql}"
        f" ORDER BY g.next_review_ts LIMIT 1", [now, *params]).fetchone()
    if row is None:
        row = con.execute(
            f"SELECT p.* FROM puzzles p LEFT JOIN progress g ON g.puzzle_id = p.id"
            f" WHERE g.puzzle_id IS NULL{wsql} ORDER BY RANDOM() LIMIT 1",
            params).fetchone()
    if row is None:
        row = con.execute(
            f"SELECT p.* FROM puzzles p WHERE 1=1{wsql} ORDER BY RANDOM() LIMIT 1",
            params).fetchone()
    return _puzzle_dict(row) if row else None


def get_puzzle(con: sqlite3.Connection, pid: int) -> dict | None:
    row = con.execute("SELECT * FROM puzzles WHERE id = ?", (pid,)).fetchone()
    return _puzzle_dict(row) if row else None


def _puzzle_dict(row: sqlite3.Row) -> dict:
    """puzzle row → 前端 JSON（answer 解析成 list；含 progress 若有）。"""
    d = dict(row)
    d["answer_iccs"] = json.loads(d["answer_iccs"])
    d["answer_zh"] = json.loads(d["answer_zh"])
    return d


def check_answer(con: sqlite3.Connection, pid: int, user_iccs,
                 time_ms: int = 0) -> dict | None:
    """評使用者**首著**：對書答首著或引擎最佳著（已存 engine_best＝引擎等值）相符即過。
    記一筆 attempt＋更新 progress（間隔重練）。回判定＋完整答案供 UI 揭示。

    （首著評分為第一版；多步逐著、落子後引擎再評等值，留待後續迭代。）
    """
    row = con.execute("SELECT * FROM puzzles WHERE id = ?", (pid,)).fetchone()
    if row is None:
        return None
    answer = json.loads(row["answer_iccs"])
    answer_zh = json.loads(row["answer_zh"])
    expected = answer[0] if answer else None
    user_first = user_iccs[0] if isinstance(user_iccs, list) else user_iccs
    correct, via = False, None
    if expected and user_first == expected:
        correct, via = True, "book"
    elif row["engine_best"] and user_first == row["engine_best"]:
        correct, via = True, "engine"
    record_attempt(con, pid, "pass" if correct else "fail", user_first, time_ms)
    update_progress(con, pid, correct)
    return {
        "correct": correct, "via": via,
        "expected_iccs": expected,
        "expected_zh": answer_zh[0] if answer_zh else None,
        "engine_best": row["engine_best"],
        "answer_iccs": answer, "answer_zh": answer_zh,
        "commentary": row["commentary"], "ply_count": row["ply_count"],
    }


def record_attempt(con: sqlite3.Connection, pid: int, result: str,
                   user_iccs, time_ms: int) -> None:
    con.execute(
        "INSERT INTO attempts (puzzle_id, ts, result, user_iccs, time_ms)"
        " VALUES (?, ?, ?, ?, ?)",
        (pid, _now(), result,
         user_iccs if isinstance(user_iccs, str) else json.dumps(user_iccs),
         int(time_ms or 0)))
    con.commit()


# 間隔重練：答對沿 new/learning→review(+3d)→mastered(+7d)；答錯回 learning(+1d)。
_REVIEW_DAYS = {"learning": 1, "review": 3, "mastered": 7}


def update_progress(con: sqlite3.Connection, pid: int, passed: bool) -> None:
    row = con.execute(
        "SELECT state, fails FROM progress WHERE puzzle_id = ?", (pid,)).fetchone()
    state = row["state"] if row else "new"
    fails = row["fails"] if row else 0
    if not passed:
        state, fails, days = "learning", fails + 1, _REVIEW_DAYS["learning"]
    elif state in ("new", "learning"):
        state, days = "review", _REVIEW_DAYS["review"]
    else:  # review / mastered → mastered（之後仍每 7 天複習）
        state, days = "mastered", _REVIEW_DAYS["mastered"]
    con.execute(
        "INSERT INTO progress (puzzle_id, state, fails, next_review_ts)"
        " VALUES (?, ?, ?, ?)"
        " ON CONFLICT(puzzle_id) DO UPDATE SET"
        " state=excluded.state, fails=excluded.fails,"
        " next_review_ts=excluded.next_review_ts",
        (pid, state, fails, _future_ts(days)))
    con.commit()


def practice_progress_stats(con: sqlite3.Connection) -> dict:
    """個人成績總覽（成績分頁用）。"""
    a = con.execute(
        "SELECT COUNT(*), COALESCE(SUM(result='pass'),0) FROM attempts").fetchone()
    states = dict(con.execute(
        "SELECT state, COUNT(*) FROM progress GROUP BY state").fetchall())
    due = con.execute(
        "SELECT COUNT(*) FROM progress WHERE next_review_ts <= ?",
        (_now(),)).fetchone()[0]
    return {"attempts": a[0] or 0, "passed": a[1] or 0,
            "states": states, "due": due}


# ---------- 統計 / CLI -------------------------------------------------------

def stats(con: sqlite3.Connection) -> dict:
    total = con.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0]
    by_diff = dict(con.execute(
        "SELECT difficulty, COUNT(*) FROM puzzles GROUP BY difficulty").fetchall())
    by_verdict = dict(con.execute(
        "SELECT COALESCE(engine_verdict,'(未複核)'), COUNT(*)"
        " FROM puzzles GROUP BY engine_verdict").fetchall())
    by_book = con.execute(
        "SELECT book_title, COUNT(*) c FROM puzzles GROUP BY book_title"
        " ORDER BY c DESC LIMIT 20").fetchall()
    return {
        "total": total,
        "by_difficulty": by_diff,
        "by_verdict": by_verdict,
        "top_books": [(r["book_title"], r["c"]) for r in by_book],
    }


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _future_ts(days: float) -> str:
    """now + days → 同 _now() 格式的可排序字串（間隔重練到期時間）。"""
    return time.strftime("%Y-%m-%d %H:%M:%S",
                         time.localtime(time.time() + days * 86400))


def _print_extract(results: list[dict], elapsed: float) -> None:
    tot_add = sum(r.get("added", 0) for r in results)
    tot_skip = sum(r.get("skipped", 0) for r in results)
    reasons: dict[str, int] = {}
    for r in results:
        for k, v in (r.get("reasons") or {}).items():
            reasons[k] = reasons.get(k, 0) + v
    print(f"抽題完成：{len(results)} 檔，加入 {tot_add} 題、濾掉 {tot_skip} "
          f"（{elapsed:.1f}s）")
    if reasons:
        print("  濾除原因：" + "，".join(f"{k}×{v}" for k, v in sorted(reasons.items())))
    # 列每檔加入數（多到少）
    for r in sorted(results, key=lambda x: -x.get("added", 0))[:25]:
        if "error" in r:
            print(f"  ✗ {r['file']}：{r['error']}")
        else:
            print(f"  {r['added']:5d} 題（濾 {r['skipped']:4d}）  {r['file']}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="practice_service",
                                 description="中局練習題庫抽題管線")
    ap.add_argument("--db", default=str(PRACTICE_DB_PATH), help="practice.db 路徑")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("extract", help="抽題（單檔或資料夾遞迴）")
    pe.add_argument("target", help=".cbl 檔或資料夾")
    pe.add_argument("--root", default=None, help="source_rel 的相對根（預設 target 父層）")
    pe.add_argument("--min-ply", type=int, default=DEFAULT_MIN_PLY)
    pe.add_argument("--depth", type=int, default=12, help="仲裁深度")
    pe.add_argument("--no-engine", action="store_true", help="只抽題、不跑引擎仲裁")

    pa = sub.add_parser("arbitrate", help="對既有未複核題補跑引擎")
    pa.add_argument("--depth", type=int, default=12)
    pa.add_argument("--limit", type=int, default=None)
    pa.add_argument("--fresh", action="store_true", help="重跑全部（含已複核）")

    sub.add_parser("stats", help="題庫統計")

    ps = sub.add_parser("export-seed",
                        help="把題庫匯出成版控 seed（data/practice_seed.db）")
    ps.add_argument("--seed", default=None, help="seed 輸出路徑（預設 PRACTICE_SEED_PATH）")

    args = ap.parse_args(argv)
    con = connect(Path(args.db))
    try:
        if args.cmd == "extract":
            target = Path(args.target)
            if not target.exists():
                print(f"找不到：{target}", file=sys.stderr)
                return 2
            root = Path(args.root) if args.root else None
            t0 = time.monotonic()
            results = extract_path(con, target, root, min_ply=args.min_ply)
            _print_extract(results, time.monotonic() - t0)
            if not args.no_engine:
                engine = config._get_pikafish()
                if not engine.exists():
                    print(f"⚠ 找不到引擎，略過仲裁：{engine}")
                else:
                    print(f"引擎仲裁中（depth {args.depth}）…")
                    t0 = time.monotonic()
                    res = arbitrate(con, engine, depth=args.depth)
                    print(f"  仲裁 {res['arbitrated']} 題（{time.monotonic()-t0:.1f}s）："
                          + "，".join(f"{k}×{v}" for k, v in res["verdicts"].items()))
        elif args.cmd == "arbitrate":
            engine = config._get_pikafish()
            if not engine.exists():
                print(f"找不到引擎：{engine}", file=sys.stderr)
                return 2
            t0 = time.monotonic()
            res = arbitrate(con, engine, depth=args.depth, limit=args.limit,
                            fresh=args.fresh)
            print(f"仲裁 {res['arbitrated']} 題（{time.monotonic()-t0:.1f}s）："
                  + "，".join(f"{k}×{v}" for k, v in res["verdicts"].items()))
        elif args.cmd == "stats":
            s = stats(con)
            print(f"題庫共 {s['total']} 題")
            print("  難度帶：" + "，".join(f"{k}★×{v}" for k, v in sorted(s["by_difficulty"].items())))
            print("  複核：" + "，".join(f"{k}×{v}" for k, v in s["by_verdict"].items()))
            print("  書目（前 20）：")
            for name, c in s["top_books"]:
                print(f"    {c:5d}  {name}")
        elif args.cmd == "export-seed":
            seed = Path(args.seed) if args.seed else PRACTICE_SEED_PATH
            n = export_seed(con, seed)
            print(f"已匯出 {n} 題 → {seed}（版控 seed；記得 git add + commit）")
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
