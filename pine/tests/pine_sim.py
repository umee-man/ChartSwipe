"""Python mirror of the parser in pine/chartswipe.pine, checked against pine/test_vectors.json.

Run: python pine/tests/pine_sim.py   (exit code 0 = all vectors pass)

This mirrors the Pine rules line by line so the §7 string contract has one executable
reference that the api/ and web/lib/pine/ generators can round-trip against. It does NOT
replace compiling the indicator in the TradingView Pine Editor (manual QA item).
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

VECTORS = Path(__file__).resolve().parent.parent / "test_vectors.json"

# Approximation of Pine str.tonumber: plain decimal with optional sign and exponent.
# Exponent acceptance by Pine is unverified; vectors that depend on it are flagged
# with "requires_exponent_tonumber".
_NUM = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def tonumber(s: str) -> float | None:
    return float(s) if _NUM.match(s) else None


def normalize_symbol(raw: str) -> str:
    s = raw.strip().upper()
    if ":" in s:
        s = s.split(":")[-1].strip()
    if s.endswith(".P"):
        s = s[:-2]
    return s


def parse_level(raw: str):
    tok = raw.strip().lower()
    n = len(tok)
    if n < 2:
        return "", None, None
    k = tok[-1]
    body = tok[:-1].strip()
    if k in ("s", "r"):
        v = tonumber(body)
        if v is not None and v > 0:
            return k, v, None
    elif k == "z":
        bn = len(body)
        split_at = -1
        if bn >= 3:
            for i in range(1, bn - 1):  # Pine: for i = 1 to bn - 2 (inclusive)
                if body[i] == "-" and body[i - 1] != "e":
                    split_at = i
                    break
        if split_at > 0:
            a = tonumber(body[:split_at].strip())
            b = tonumber(body[split_at + 1:].strip())
            if a is not None and b is not None and a > 0 and b > 0:
                return k, min(a, b), max(a, b)
    return "", None, None


def run(levels_input: str, ticker: str):
    chart = normalize_symbol(ticker)
    src = levels_input.replace("\n", ";").replace('"', "")
    out, bad = [], 0
    for entry in src.split(";"):
        e = entry.strip()
        if not e:
            continue
        parts = e.split(":")
        if len(parts) < 2:
            bad += 1
            continue
        if normalize_symbol(parts[-2]) != chart:
            continue
        for tok in parts[-1].split(","):
            if not tok.strip():
                continue
            kind, p1, p2 = parse_level(tok)
            if kind == "":
                bad += 1
                continue
            out.append([kind, p1, p2])
    return out, bad


def _same(a, b) -> bool:
    if a is None or b is None:
        return a is b
    return math.isclose(a, b, rel_tol=1e-12)


def main() -> int:
    cases = json.loads(VECTORS.read_text(encoding="utf-8"))["cases"]
    failed = 0
    for c in cases:
        levels, bad = run(c["input"], c["ticker"])
        exp = c["levels"]
        ok = bad == c["bad"] and len(levels) == len(exp) and all(
            g[0] == e[0] and _same(g[1], e[1]) and _same(g[2], e[2]) for g, e in zip(levels, exp)
        )
        print(f"{'PASS' if ok else 'FAIL'}  {c['name']}")
        if not ok:
            failed += 1
            print(f"      got levels={levels} bad={bad}; expected levels={exp} bad={c['bad']}")
    print(f"{len(cases) - failed}/{len(cases)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
