#!/usr/bin/env python3
"""Execute a deterministic grid of moving-average strategies from one price download.

Each parameter combination is independently evaluated and returned with its
metrics.  The caller persists every result as its own backtest run, preserving
the audit trail without paying for fifty redundant model/code-generation calls.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

from run_backtest import compute_metrics, download_prices


def moving_average_signal(prices: pd.DataFrame, short_window: int, long_window: int) -> pd.Series:
    close = pd.to_numeric(prices.get("adj_close", prices["close"]), errors="coerce").ffill()
    short = close.rolling(short_window, min_periods=short_window).mean()
    long = close.rolling(long_window, min_periods=long_window).mean()
    return (short > long).astype(float).fillna(0.0)


def main() -> None:
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    prices = download_prices(
        config["symbol"], config["start_date"], config.get("end_date"), config.get("market_data_cutoff_at")
    )
    benchmark = None
    if config.get("benchmark_symbol"):
        benchmark = download_prices(
            config["benchmark_symbol"], config["start_date"], config.get("end_date"), config.get("market_data_cutoff_at")
        )
    close = pd.to_numeric(prices.get("adj_close", prices["close"]), errors="coerce").ffill()
    raw_returns = close.pct_change().fillna(0.0)
    initial_capital = float(config.get("initial_capital") or 100000)
    benchmark_equity = None
    if benchmark is not None:
        benchmark_close = pd.to_numeric(benchmark.get("adj_close", benchmark["close"]), errors="coerce").ffill()
        benchmark_returns = benchmark_close.pct_change().fillna(0.0)
        benchmark_equity = initial_capital * (1.0 + benchmark_returns).cumprod()

    results = []
    for item in config["combinations"]:
        params = item["params"]
        signal = moving_average_signal(prices, int(params["short_window"]), int(params["long_window"]))
        returns = signal.shift(1).fillna(0.0) * raw_returns
        equity = initial_capital * (1.0 + returns).cumprod()
        results.append({
            "combination_key": item["combination_key"],
            "params": params,
            "metrics": compute_metrics(equity, returns, signal, initial_capital, benchmark_equity),
        })
    print(json.dumps({"results": results, "observations": int(len(prices))}))


if __name__ == "__main__":
    main()
