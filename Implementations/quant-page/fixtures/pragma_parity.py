"""Run Pragma's real PulseValue (pulsevalue.py) on each fixture and write the golden results.

Usage: python -I pragma_parity.py <path-to-Pragma/pragma-web/api/app/services/pulsevalue.py>

yfinance is stubbed, the indicator cache is empty (so the Credit Impact Scalar is 1.0, as in Pragma without it),
and the S&P 500 peer-growth lookup returns None, matching the TypeScript port's documented differences.
"""
import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile
import types

import pandas as pd

HERE = pathlib.Path(__file__).resolve().parent


def load_pulsevalue(source: pathlib.Path):
    pkg_dir = pathlib.Path(tempfile.mkdtemp()) / "pragma_pkg"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "indicators.py").write_text(
        "def get_cached_indicators():\n    return None\n\n"
        "def build_all_indicators():\n    raise RuntimeError('no indicators in parity runs')\n"
    )
    shutil.copy(source, pkg_dir / "pulsevalue.py")
    sys.modules["yfinance"] = types.ModuleType("yfinance")
    sys.path.insert(0, str(pkg_dir.parent))
    spec = importlib.util.spec_from_file_location("pragma_pkg.pulsevalue", pkg_dir / "pulsevalue.py",
                                                  submodule_search_locations=None)
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "pragma_pkg"
    sys.modules["pragma_pkg.pulsevalue"] = module
    spec.loader.exec_module(module)
    return module


def frame(statement: dict) -> pd.DataFrame:
    cols = [pd.Timestamp(p) for p in statement["periods"]]
    if not cols or not statement["rows"]:
        return pd.DataFrame()
    rows = {k: [float("nan") if v is None else float(v) for v in vals] for k, vals in statement["rows"].items()}
    return pd.DataFrame.from_dict(rows, orient="index", columns=cols)


def main(source: str) -> None:
    pv = load_pulsevalue(pathlib.Path(source))
    pv._compute_industry_revenue_growth = lambda *a, **k: None
    out_dir = HERE / "golden"
    out_dir.mkdir(exist_ok=True)
    for case_path in sorted((HERE / "cases").glob("*.json")):
        case = json.loads(case_path.read_text(encoding="utf-8"))
        d = case["data"]
        hist = pd.DataFrame({"Close": [h["close"] for h in d["history"]]},
                            index=pd.DatetimeIndex([h["day"] for h in d["history"]]))
        info = dict(d["info"])
        info.update({"sector": case["meta"]["sector"], "industry": case["meta"]["industry"],
                     "shortName": case["meta"]["companyName"]})
        data = {"info": info, "income": frame(d["income"]), "income_quarterly": frame(d["income_quarterly"]),
                "balance": frame(d["balance"]), "cashflow": frame(d["cashflow"]), "history": hist}
        pv._fetch_ticker_data = lambda _t, data=data: data
        pv._TICKER_CACHE.clear()
        result = pv.compute_pulse_value(case["name"].upper(), force_refresh=True).to_dict()
        result.pop("historical_prices_5y", None)
        result.pop("computed_at", None)
        (out_dir / f"{case['name']}.json").write_text(json.dumps(result, indent=1, default=float), encoding="utf-8")
        print(case["name"], result["engine_used"], result["pulse_score"], result["base_target"])


if __name__ == "__main__":
    main(sys.argv[1])
