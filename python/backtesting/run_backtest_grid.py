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


def period_metrics(
    returns: pd.Series,
    signal: pd.Series,
    benchmark_returns: pd.Series | None,
    initial_capital: float,
) -> dict:
    period_returns = returns.fillna(0.0)
    equity = initial_capital * (1.0 + period_returns).cumprod()
    benchmark_equity = None
    if benchmark_returns is not None:
        benchmark_equity = initial_capital * (1.0 + benchmark_returns.reindex(period_returns.index).fillna(0.0)).cumprod()
    return compute_metrics(equity, period_returns, signal.reindex(period_returns.index).fillna(0.0), initial_capital, benchmark_equity)


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
    benchmark_returns = None
    if benchmark is not None:
        benchmark_close = pd.to_numeric(benchmark.get("adj_close", benchmark["close"]), errors="coerce").ffill()
        benchmark_returns = benchmark_close.pct_change().fillna(0.0)
        benchmark_equity = initial_capital * (1.0 + benchmark_returns).cumprod()

    split_index = max(1, min(len(prices) - 1, int(len(prices) * 0.70)))
    split_date = prices.index[split_index].date().isoformat()

    results = []
    for item in config["combinations"]:
        params = item["params"]
        signal = moving_average_signal(prices, int(params["short_window"]), int(params["long_window"]))
        returns = signal.shift(1).fillna(0.0) * raw_returns
        equity = initial_capital * (1.0 + returns).cumprod()
        in_sample = period_metrics(returns.iloc[:split_index], signal.iloc[:split_index], benchmark_returns, initial_capital)
        out_of_sample = period_metrics(returns.iloc[split_index:], signal.iloc[split_index:], benchmark_returns, initial_capital)
        results.append({
            "combination_key": item["combination_key"],
            "params": params,
            "metrics": {
                **compute_metrics(equity, returns, signal, initial_capital, benchmark_equity),
                "in_sample": in_sample,
                "out_of_sample": out_of_sample,
                "split_date": split_date,
                "selection_rule": "Parameters are ranked on in-sample return only; out-of-sample data is untouched until evaluation.",
                "out_of_sample_excess_return": out_of_sample["total_return"] - out_of_sample.get("benchmark_total_return", 0.0),
            },
        })

    for result in results:
        params = result["params"]
        neighbors = [
            candidate for candidate in results
            if candidate is not result
            and abs(int(candidate["params"]["short_window"]) - int(params["short_window"])) <= 5
            and abs(int(candidate["params"]["long_window"]) - int(params["long_window"])) <= 50
        ]
        neighbor_returns = [candidate["metrics"]["out_of_sample"]["total_return"] for candidate in neighbors]
        result["metrics"]["parameter_stability"] = {
            "neighbor_count": len(neighbor_returns),
            "neighbor_mean_out_of_sample_return": sum(neighbor_returns) / len(neighbor_returns) if neighbor_returns else None,
            "positive_neighbor_fraction": sum(value > 0 for value in neighbor_returns) / len(neighbor_returns) if neighbor_returns else None,
        }
    ranked = sorted(results, key=lambda item: item["metrics"]["in_sample"]["total_return"], reverse=True)
    for rank, result in enumerate(ranked, start=1):
        result["metrics"]["in_sample_rank"] = rank
    print(json.dumps({"results": results, "observations": int(len(prices)), "split_date": split_date, "split_ratio": 0.70}))


if __name__ == "__main__":
    main()
