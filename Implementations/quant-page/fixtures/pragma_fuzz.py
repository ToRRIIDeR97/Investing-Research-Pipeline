"""Seeded differential fuzz: mutate the eight parity fixtures and record Pragma's own PulseValue results.

Usage: python pragma_fuzz.py <path-to-pulsevalue.py> [count=200]
Writes fuzz.json: each entry is a base fixture name plus the mutated statements, info, meta and credit z, and
Pragma's result (or the error it raised). The price history is the base fixture's, so the file stays small.
Mutations (from the first review round): engines forced across sectors (and named asset owners), credit z,
2-5 years of data with nulls and negatives, quarterly margins, forward EPS and growth, dividend yield in percent,
tax rate, ROE, beta, capex/D&A rows and the Long Term Debt fallback.
"""
import copy
import json
import pathlib
import random
import sys

import pandas as pd

import pragma_parity as pp

METAS = [("Technology", "Software—Application"), ("Technology", "Semiconductors"), ("Financial Services", "Banks—Regional"),
         ("Financial Services", "Insurance—Diversified"), ("Financial Services", "Asset Management"), ("Real Estate", "REIT—Retail"),
         ("Utilities", "Utilities—Regulated Electric"), ("Energy", "Oil & Gas E&P"), ("Basic Materials", "Gold"),
         ("Healthcare", "Biotechnology"), ("Healthcare", "Drug Manufacturers—General"), ("Consumer Cyclical", "Auto Manufacturers"),
         ("Industrials", "Industrials")]


def mutate(rnd: random.Random, base: dict) -> dict:
    c = copy.deepcopy(base)
    d = c["data"]
    sec, ind = rnd.choice(METAS)
    c["meta"] = {"sector": sec, "industry": ind, "companyName": rnd.choice(["Fixture Co", "Berkshire X", "Z"])}
    info = d["info"]
    for k in list(info):
        if isinstance(info[k], (int, float)) and rnd.random() < 0.5:
            info[k] = info[k] * rnd.choice([0.3, 0.7, 1.5, 2.5, -1])
    for k, v in [("forwardEps", rnd.choice([3, 8])), ("trailingEps", rnd.choice([4, 6])), ("earningsGrowth", rnd.choice([0.1, -0.2, 12])),
                 ("revenueGrowth", 0.05), ("dividendYield", rnd.choice([0.03, 3.2])), ("returnOnEquity", rnd.choice([0.05, 0.2, -0.1])),
                 ("bookValue", rnd.choice([10, 30])), ("beta", 1.3), ("effectiveTaxRate", rnd.choice([0.0, 0.3, 0.6])),
                 ("ebit", rnd.choice([5e8, -1e8])), ("ebitda", rnd.choice([1e9, 0])), ("grossProfits", 2e9)]:
        if rnd.random() < 0.3:
            info[k] = v
    keep = rnd.choice([5, 5, 4, 3, 2])
    for s in ("income", "balance", "cashflow"):
        st = d[s]
        if st["periods"]:
            st["periods"] = st["periods"][:keep]
            for r in st["rows"]:
                st["rows"][r] = st["rows"][r][:keep]
                for j in range(len(st["rows"][r])):
                    if rnd.random() < 0.08:
                        st["rows"][r][j] = None
                    elif rnd.random() < 0.05 and st["rows"][r][j] is not None:
                        st["rows"][r][j] = -abs(st["rows"][r][j])
    if rnd.random() < 0.4 and (d["income"]["rows"].get("Total Revenue") or [None])[0]:
        rev = [d["income"]["rows"]["Total Revenue"][0] / 4] * 4
        m = rnd.choice([[0.2, 0.18, 0.15, 0.12], [0.1, 0.12, 0.14, 0.15]])
        d["income_quarterly"] = {"periods": ["2025-12-31", "2025-09-30", "2025-06-30", "2025-03-31"],
                                 "rows": {"Total Revenue": rev, "Operating Income": [r * x for r, x in zip(rev, m)]}}
    if rnd.random() < 0.3:
        ocf = d["cashflow"]["rows"].get("Operating Cash Flow", [None] * len(d["cashflow"]["periods"]))
        d["cashflow"]["rows"]["Capital Expenditure"] = [-x * 0.3 if x else None for x in ocf]
        d["cashflow"]["rows"]["Depreciation And Amortization"] = [x * 0.2 if x else None for x in ocf]
        d["balance"]["rows"].pop("Total Debt", None)
        d["balance"]["rows"]["Long Term Debt"] = [5e9] * len(d["balance"]["periods"])
    c["credit_z"] = rnd.choice([None, None, -2.0, 1.5, 3.0])
    return c


def main(source: str, count: int) -> None:
    pv, _trend, _patterns = pp.load_pulsevalue(pathlib.Path(source))
    pv._compute_industry_revenue_growth = lambda *a, **k: None
    bases = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted((pp.HERE / "cases").glob("*.json"))}
    names = sorted(bases)
    rnd = random.Random(7)
    out = []
    for _ in range(count):
        name = rnd.choice(names)
        c = mutate(rnd, bases[name])
        d = c["data"]
        info = dict(d["info"])
        info.update({"sector": c["meta"]["sector"], "industry": c["meta"]["industry"], "shortName": c["meta"]["companyName"]})
        hist = pd.DataFrame({"Close": [h["close"] for h in d["history"]]}, index=pd.DatetimeIndex([h["day"] for h in d["history"]]))
        data = {"info": info, "income": pp.frame(d["income"]), "income_quarterly": pp.frame(d["income_quarterly"]),
                "balance": pp.frame(d["balance"]), "cashflow": pp.frame(d["cashflow"]), "history": hist}
        z = c["credit_z"]
        pv._fetch_ticker_data = lambda _t, data=data: data
        pv._get_cis_z = lambda z=z: 0.0 if z is None else z
        pv._TICKER_CACHE.clear()
        entry = {"base": name, "meta": c["meta"], "credit_z": z,
                 "data": {k: d[k] for k in ("info", "income", "income_quarterly", "balance", "cashflow")}}
        try:
            r = pv.compute_pulse_value("X", force_refresh=True).to_dict()
            entry["gold"] = {k: r[k] for k in ("engine_used", "confidence_score", "pulse_score", "bear_target", "base_target",
                                               "bull_target", "v_deviation", "pq_deviation", "quality_flags", "structural_flags")}
            entry["gold"]["dcf"] = {k: r["dcf"][k] for k in ("dcf_skipped", "discount_rate", "exit_metric", "intrinsic_value_base")}
        except Exception as exc:  # recorded: the port should fail too, or the test notes it
            entry["error"] = str(exc)
        out.append(entry)
    (pp.HERE / "fuzz.json").write_text(json.dumps(out, default=float, separators=(",", ":")), encoding="utf-8")
    print(len(out), "cases,", sum(1 for e in out if "error" in e), "errors")


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 200)
