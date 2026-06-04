# 雲庫評分抓取方法（chessdb.cn）

> 來源：chess-book-ai 的 [`site_builder/chessdb_query.py`](../../chess-book-ai/site_builder/chessdb_query.py)。
> 本文把「怎麼抓 chessdb.cn 雲庫評分」整理給 editor，方便在編輯盤面時即時顯示社群分析。

## 1. 雲庫提供什麼

chessdb.cn 是象棋雲端開局庫，對一個盤面回傳**社群累積的每個合法著法**的：

| 欄位 | 意義 |
|---|---|
| `iccs` | 著法（與 Pikafish / 本專案同格式，files a–i、ranks 0–9，例 `h2e2`）|
| `score` | 評分（**centipawn，走子方視角**；正＝走子方有利）|
| `rank` | 雲庫推薦等級（0=最佳，數字越大越次）|
| `winrate` | 勝率百分比（0–100，社群對局統計）|
| `note` | 備註字串（多為空）|

第一個 move（`moves[0]`）就是雲庫的最佳著。

## 2. 兩條取得路徑

### A. 快取（已抓過的局面）—— 讀 `positions.db`
chess-book-ai 已把抓過的雲庫資料 migrate 進 `output/positions.db`：

```sql
CREATE TABLE chessdb (
  fen        TEXT PRIMARY KEY,   -- 完整 FEN（含 side，但抓取時只用 position+side，見 §4）
  status     TEXT,               -- 'ok' / 'unknown' / 'invalid board' / 'checkmate' ...
  moves_json TEXT                -- JSON 陣列：[{iccs,score,rank,note,winrate}, ...]
);
```

editor 已唯讀消費 positions.db，**優先查這裡**：命中就免打網路。讀法：

```python
row = conn.execute("SELECT status, moves_json FROM chessdb WHERE fen = ?", (fen,)).fetchone()
if row and row[0] == 'ok':
    moves = json.loads(row[1])          # list of dicts
    best = moves[0] if moves else None
```

> 注意：DB 的 `fen` 鍵是抓取時用的鍵。本專案抓取前會把 FEN 修剪成 `position side`（§4），
> 但 migrate 進 DB 時用的是當時 positions.js 的**完整 FEN** 當鍵。若 editor 用完整 FEN 查不到，
> 退而用 §4 修剪後的 FEN 比對，或直接走路徑 B 即時查。

### B. 即時查（任意新盤面）—— 打 API
editor 讓使用者自由擺盤，會遇到 DB 沒有的局面 → 即時查 chessdb.cn，再寫回快取。方法見下。

## 3. API 規格

```
GET http://www.chessdb.cn/chessdb.php?action=queryall&board=<trimmed_fen>
```

- **協定是 `http`**（非 https）。
- `action=queryall`：回傳所有著法（本專案用這個）。其他 action（`querybest`、`querypv`…）本專案未用，要用請自行驗證。
- `board`：**修剪後的 FEN**（見 §4），需 urlencode。
- timeout 建議 10s。

### 回應格式
管線字串，`|` 分隔每個著法，著法內 `,` 分隔 `key:value`：

```
move:h2e2,score:23,rank:0,note:! ,winrate:54.8|move:b2e2,score:12,rank:1,...
```

錯誤/特殊狀態是單一字串（非管線格式）：
`invalid board` / `unknown`（庫中無此局面）/ `checkmate` / `stalemate` / `nobestmove`。

## 4. FEN 修剪（重要）

chessdb 只吃 `<position> <side>`，**要丟掉 halfmove / fullmove 計數**，否則查不到：

```python
def trim_fen(fen: str) -> str:
    parts = fen.split()
    return ' '.join(parts[:2]) if len(parts) >= 2 else fen
# "rnbak..../9/... w 0 1"  →  "rnbak..../9/... w"
```

## 5. 已知陷阱（務必處理）

1. **NUL byte**：chessdb 偶爾在回應尾端塞一個 `\x00`，不剝掉的話 `float('54.8\x00')` 會炸。**先 `text.replace('\x00','')`**。（本專案 2026-05-15 踩過。）
2. **欄位可能缺**：`score` / `winrate` 不一定每個 move 都有 → 解析時做 isdigit / 存在性檢查，缺就給 `None`。
3. **http 非 https**。
4. **錯誤狀態**要先攔（見 §3），不要當管線字串硬解。
5. **分數視角**：`score` 是走子方視角的 centipawn。要和引擎分數比對時注意兩邊視角是否一致（本專案引擎分數也是走子方視角，可直接比）。

## 6. 禮貌規範（避免被封）

- 每次查詢間隔 **0.2 秒（~5 req/s）**。
- **務必快取**：查過的 FEN 寫回（DB 或 json），re-run 免重打。
- 批次大量查時每 N 筆 checkpoint 一次快取，斷線可續。

editor 即時查單一盤面（使用者點一下才查），自然滿足速率；只要記得**寫回快取**即可。

## 7. 參考實作（可直接搬進 editor backend）

```python
import json, urllib.parse, urllib.request

API = "http://www.chessdb.cn/chessdb.php"

def trim_fen(fen: str) -> str:
    parts = fen.split()
    return ' '.join(parts[:2]) if len(parts) >= 2 else fen

def query_chessdb(fen: str, timeout: int = 10) -> dict:
    """回傳 {'status': 'ok'|<err>, 'moves': [ {iccs,score,rank,note,winrate}, ... ]}"""
    q = urllib.parse.urlencode({'action': 'queryall', 'board': trim_fen(fen)})
    with urllib.request.urlopen(f"{API}?{q}", timeout=timeout) as r:
        text = r.read().decode('utf-8', errors='replace')
    text = text.replace('\x00', '').strip()                 # NUL-byte guard
    if not text:
        return None
    if text in ('invalid board', 'unknown', 'checkmate', 'stalemate', 'nobestmove'):
        return {'status': text, 'moves': []}
    moves = []
    for chunk in text.split('|'):
        kv = {}
        for pair in chunk.split(','):
            if ':' in pair:
                k, v = pair.split(':', 1)
                kv[k] = v.strip()
        if 'move' not in kv:
            continue
        moves.append({
            'iccs':    kv.get('move'),
            'score':   int(kv['score'])   if kv.get('score', '').lstrip('-').isdigit() else None,
            'rank':    int(kv['rank'])    if kv.get('rank', '').isdigit() else None,
            'note':    kv.get('note', ''),
            'winrate': float(kv['winrate']) if kv.get('winrate') else None,
        })
    return {'status': 'ok', 'moves': moves}
```

## 8. editor 整合（cache-first）—— ✅ 已實作（2026-06-04）

已落地為 `GET /api/chessdb?fen=...`（`backend/chessdb_service.py` `lookup`）：

1. 先查 `positions.db` 的 `chessdb` 表（完整 FEN，miss 再試修剪 FEN）。
2. 命中 → 直接回傳。
3. Miss → 查 editor **自有**快取 `output/editor_chessdb_cache.db`；再 miss 才
   `query_chessdb(fen)` 即時抓 → 回傳並寫回**自有快取**（不寫唯讀 positions.db、
   也不碰 ai repo 的 `chessdb_cache.json`）。`fresh=1` 可跳過兩層快取重打。
4. 前端「☁ 雲庫」tab（`renderCdbTab`）列出全部雲庫著法（中文/勝率/紅POV分/★最佳），
   並標出目前所在變化；點列＝`addCdbMove` 在分支點加同層變化或切換過去；棋盤下方
   評估列「雲」格顯示分支點最佳著＋勝率。導航時 `ensureCdbLive` lazy 查（debounce 220ms）。
   **查的是「前一步＝分支點」局面**（`cdbFen`，同引擎「前一步」），所以列出的是「該分支
   可以怎麼走」（本著＋替代著），而非「走完本步後對手如何因應」。

> 實作細節與設計原則見 [ARCHITECTURE.md](../ARCHITECTURE.md)（§2 雲庫 cache-first
> 列、§3 chessdb_service 表）與 [CLAUDE.md](../CLAUDE.md)「Live cloud-library query」節。

## 9. ply 窗口（ai 管線策略，editor 可不照搬）

ai 站只抓 **第 10–25 手**（`PLY_RANGE`）的盤面：前 10 手是開局理論（每條合理路線都覆蓋）、25 手後雲庫資料稀疏且已過開局書框架。editor 是逐盤即時查，**沒有此限制**——使用者擺哪查哪即可。
