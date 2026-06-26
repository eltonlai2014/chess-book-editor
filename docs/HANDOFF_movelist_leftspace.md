# Handoff — 棋譜清單左側空白未善用

> **一次性 handoff**（新 session 接手用）。任務完成後**刪除本檔**（本 repo 慣例：
> handoff/review 鷹架做完即清，見既有 backlog 收尾紀錄）。
> 先讀 [ARCHITECTURE.md](../ARCHITECTURE.md) §「棋譜列／注解／走法分支」與
> [docs/DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)（樣式改動歸這份）。

## 目標（主人原話）

> 「棋譜左側空間未善用」——右欄「棋譜」走子清單**最左側有一條明顯空白帶**，
> 號碼與著法都被推到偏右，左邊一大塊沒用到。主人圈的就是那條左空隙。

主人尚未指定要「**收掉**空白（內容左移、更緊湊）」還是「**填用**空白（放點東西進去）」
——**這是要先和主人敲定的方向**（見下「待主人裁示」）。

## 根因（已查證，file:line）

每個 ply 是一列 `.plyLine`（`display:flex`），結構：`[.plyNum][.plyText][.plyMark…]`
（`renderPlyRow`，[editor.js:1514](../frontend/assets/editor.js#L1514)）。左空白來自三層相加：

| 來源 | 值 | 位置 |
|---|---|---|
| `#moveList` 左 padding | `padding: 12px 0 12px 12px` | [editor.css:1897](../frontend/assets/editor.css#L1897) |
| `.plyLine` 左 padding ＋ 左邊框 | `padding: 2px 8px` ＋ `border-left: 2px`（active 才上色） | [editor.css:1906](../frontend/assets/editor.css#L1906) |
| `.plyNum` 序號欄 | `min-width: 38px; text-align: right; padding-right: 10px` | [editor.css:1931](../frontend/assets/editor.css#L1931) |

- 關鍵：`.plyNum` 是 **38px 寬、右對齊** 的固定欄。號碼（"1."）靠右貼近著法，
  欄左側那段就空著；**黑方列序號是空字串**（`renderPlyRow` 只有 `ply%2===1` 紅方列填
  `pairNo+"."`，黑方填 `""`）但**仍佔 38px** 做對齊→整列左邊一片空白。
- 著法 `.plyText` 是 `flex:1 1 auto`（[editor.css:1958](../frontend/assets/editor.css#L1958)），
  右側也有餘裕（著法短、面板寬），但主人這次只點左側。

## 待主人裁示（動手前先問，2-3 句帶選項＋建議）

**方向 A — 收掉空白（最簡、低風險）**：縮 `.plyNum min-width`（38→~22px）、改
`text-align:left`、砍 `#moveList`/`.plyLine` 左 padding。內容整體左移、清單更緊湊。
符合主人「靠左對齊優先、別過度設計」。**我的預設建議先做這個**，最便宜、可逆。

**方向 B — 填用空白（較大、需設計）**：把右側的標記（分支／注解／⚠陷阱／✨妙手 `.plyMark`）
或一個「紅方分」小欄移到左欄；或把每手的 trap/brilliant 記號擺左側當「邊條」。
資訊量增加，但要想清楚版面層級，別塞爆。

**方向 C — 紅黑並排**：目前一手一列「堆疊」，改成「紅｜黑」同列兩欄能同時吃掉左右
餘白——但這是 `renderPlyRow` 結構性改動（一列兩 ply），回歸面較大，**非必要別開**。

> 主人偏好（務必遵守）：terse 中文、**靠左對齊優先別過度設計**、UI 改動本就要 2-3 輪
> 打磨（出第一版再調，別一次想完美）；**樣式/配色改動寫進 DESIGN_SYSTEM.md，不塞
> ARCHITECTURE.md**；垂直置中用對稱 padding 別用 min-height；不准貼邊。

## 動手位置

- CSS：`#moveList` / `.plyLine` / `.plyNum` / `.plyText`（[editor.css:1897–1963](../frontend/assets/editor.css#L1897)）。
  方向 A 純 CSS。方向 B/C 才動 `renderPlyRow`（[editor.js:1514](../frontend/assets/editor.js#L1514)）。
- 改完 bump `editor.css?v=` （index.html [:8](../frontend/index.html#L8)）。
- active 列的 `border-left` 是 2px（[editor.css:1923](../frontend/assets/editor.css#L1923)）——縮左 padding 時留意它別被吃掉/錯位。

## 驗證

```powershell
# 回歸網（都應全綠）
.\.venv\Scripts\python.exe tests\test_smoke_ui.py
# 視覺：VSCode 內建 Simple Browser 會服舊 CSS 快取，用外部 Edge，或 agent 自跑
# playwright 截 #rpMoves 面板看左空隙是否消除（參考本 session 用過的拋棄式截圖腳本：
# 起 tests/_smoke_server.py 沙盒 → 開 sample → page.locator("#rpMoves").screenshot）
```

完成後：刪本檔、（若動了 .plyNum/版面）更新 DESIGN_SYSTEM.md 對應段、commit 直推 main。
