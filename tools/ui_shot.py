r"""UI self-verify helper: load a page in real Chromium, screenshot, dump styles.

Why: VSCode's built-in Simple Browser serves stale CSS (see memory
reference_vscode_webview_css_cache) and UI tweaks take 2-3 round-trips. This
lets the agent SEE the page itself — real Chromium, no webview cache — instead
of asking the master to open Edge each iteration.

Usage (always via the project venv):
  .\.venv\Scripts\python.exe tools\ui_shot.py                       # shot of 5174 root
  .\.venv\Scripts\python.exe tools\ui_shot.py --url http://127.0.0.1:5174/ --out output/ui-shots/home.png
  .\.venv\Scripts\python.exe tools\ui_shot.py --style "#evalLine:color,font-size" --style ".tree-row:padding"
  .\.venv\Scripts\python.exe tools\ui_shot.py --wait "#fileTree" --width 1400 --height 900

Screenshots default under output/ui-shots/ (gitignored). Computed styles print
as JSON so the agent can assert on exact px/colour values.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "output" / "ui-shots" / "shot.png"


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Screenshot + computed-style probe for the editor UI.")
    ap.add_argument("--url", default="http://127.0.0.1:5174/", help="page to load")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="screenshot path (png)")
    ap.add_argument("--width", type=int, default=1920, help="viewport width (large by default so panels aren't squeezed)")
    ap.add_argument("--height", type=int, default=1080, help="viewport height")
    ap.add_argument("--full-page", action="store_true", help="capture full scroll height")
    ap.add_argument("--scale", type=float, default=1.0, help="device scale factor (2 = retina/crisp)")
    ap.add_argument("--clip", help='crop region "x,y,w,h" in CSS px (overrides full-page)')
    ap.add_argument("--wait", help="CSS selector to wait for before shooting")
    ap.add_argument("--settle", type=float, default=0.4, help="extra seconds to let layout settle")
    ap.add_argument(
        "--style",
        action="append",
        default=[],
        help='computed style probe "selector:prop1,prop2"; repeatable',
    )
    ap.add_argument("--click", action="append", default=[], help="CSS selector(s) to click before shooting; repeatable")
    ap.add_argument("--theme", help='set html[data-ui-theme] before shooting (e.g. "light")')
    ap.add_argument(
        "--var",
        action="append",
        default=[],
        help='override a CSS custom prop on <html>, "--name:value"; repeatable (inline style wins over theme rules)',
    )
    ap.add_argument(
        "--inject",
        action="append",
        default=[],
        help="path to a CSS file to append as <style> (later source order → wins ties); repeatable",
    )
    return ap.parse_args()


def probe_styles(page, specs: list[str]) -> dict:
    out: dict[str, dict] = {}
    for spec in specs:
        sel, _, props = spec.partition(":")
        prop_list = [p.strip() for p in props.split(",") if p.strip()]
        out[sel] = page.evaluate(
            """([sel, props]) => {
                const el = document.querySelector(sel);
                if (!el) return {error: 'not found'};
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                const o = {_rect: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}};
                for (const p of props) o[p] = cs.getPropertyValue(p);
                return o;
            }""",
            [sel, prop_list],
        )
    return out


def main() -> int:
    args = parse_args()
    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = ROOT / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": args.width, "height": args.height},
            device_scale_factor=args.scale,
        )
        errors: list[str] = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        resp = page.goto(args.url, wait_until="networkidle", timeout=20000)
        status = resp.status if resp else None
        if args.wait:
            page.wait_for_selector(args.wait, timeout=15000)
        if args.theme:
            page.evaluate("t => document.documentElement.setAttribute('data-ui-theme', t)", args.theme)
        for css_path in args.inject:
            page.add_style_tag(content=Path(css_path).read_text(encoding="utf-8"))
        for spec in args.var:
            name, _, value = spec.partition(":")
            page.evaluate(
                "([n, v]) => document.documentElement.style.setProperty(n, v)",
                [name.strip(), value.strip()],
            )
        for sel in args.click:
            page.click(sel, timeout=10000)
        if args.settle:
            time.sleep(args.settle)

        styles = probe_styles(page, args.style) if args.style else {}
        if args.clip:
            x, y, w, h = (float(v) for v in args.clip.split(","))
            page.screenshot(path=str(out_path), clip={"x": x, "y": y, "width": w, "height": h})
        else:
            page.screenshot(path=str(out_path), full_page=args.full_page)
        title = page.title()
        browser.close()

    report = {
        "url": args.url,
        "http_status": status,
        "title": title,
        "screenshot": str(out_path),
        "viewport": {"w": args.width, "h": args.height},
        "styles": styles,
        "console": errors[:20],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
