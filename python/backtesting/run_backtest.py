#!/usr/bin/env python3
"""Local Research OS backtest runner.

The generated strategy is intentionally narrow: it can define
generate_signals(prices, params), import pandas/numpy, and return a signal
column. Data access, artifact writing, and point-in-time checks stay here.

Two phases (#11): `fetch` downloads prices with network access and runs no
strategy code; `run` executes the strategy inside the caller's OS sandbox
(no network, writes only to the backtest directory) on the fetched CSVs.
"""

from __future__ import annotations

import ast
import builtins
import json
import math
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import numpy as np
    import pandas as pd
except ImportError as exc:
    raise SystemExit(
        "Missing Python backtest dependencies. Install with: "
        "python3 -m pip install -r python/requirements.txt"
    ) from exc


ALLOWED_IMPORTS = {"pandas", "numpy"}
BLOCKED_CALLS = {"open", "exec", "eval", "compile", "__import__", "input"}
BLOCKED_ATTRS = {
    "read_csv",
    "read_excel",
    "read_parquet",
    "read_pickle",
    "to_csv",
    "to_excel",
    "to_parquet",
    "to_pickle",
}


def parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo:
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def date_only(value: str | None) -> str | None:
    parsed = parse_date(value)
    return parsed.date().isoformat() if parsed else None


def rel_path(path: Path, storage_root: Path) -> str:
    """Repository-relative path (storage/backtests/...). Never uses the cwd, which the sandbox can't read."""
    return os.path.relpath(path, storage_root.parent.parent).replace(os.sep, "/")


def normalize_prices(frame: "pd.DataFrame", symbol: str) -> "pd.DataFrame":
    if isinstance(frame.columns, pd.MultiIndex):
        if symbol in frame.columns.get_level_values(0):
            frame = frame[symbol]
        elif symbol in frame.columns.get_level_values(-1):
            frame = frame.xs(symbol, axis=1, level=-1)
        else:
            frame.columns = [
                "_".join(str(part) for part in col if part not in ("", None))
                for col in frame.columns
            ]

    rename = {
        "Open": "open",
        "High": "high",
        "Low": "low",
        "Close": "close",
        "Adj Close": "adj_close",
        "Volume": "volume",
    }
    frame = frame.rename(columns=rename)
    frame.columns = [str(col).strip().lower().replace(" ", "_") for col in frame.columns]

    if "close" not in frame.columns and "adj_close" not in frame.columns:
        raise ValueError(f"No close price returned for {symbol}")

    frame = frame.sort_index()
    frame.index = pd.to_datetime(frame.index).tz_localize(None)
    return frame.dropna(how="all")


def download_prices(
    symbol: str,
    start_date: str,
    end_date: str | None,
    market_data_cutoff_at: str | None,
) -> "pd.DataFrame":
    cutoff_date = date_only(market_data_cutoff_at)
    effective_end = end_date or cutoff_date or datetime.utcnow().date().isoformat()
    if cutoff_date and effective_end > cutoff_date:
        effective_end = cutoff_date

    import yfinance as yf  # only the fetch phase, which runs no strategy code, needs the network

    exclusive_end = (
        datetime.fromisoformat(effective_end) + timedelta(days=1)
    ).date().isoformat()
    prices = yf.download(
        symbol,
        start=start_date,
        end=exclusive_end,
        auto_adjust=False,
        progress=False,
        threads=False,
    )
    prices = normalize_prices(prices, symbol)
    if prices.empty:
        raise ValueError(f"No market data returned for {symbol}")

    if cutoff_date:
        max_date = prices.index.max().date().isoformat()
        if max_date > cutoff_date:
            raise ValueError(
                f"Market data for {symbol} extends beyond cutoff "
                f"{cutoff_date}: max date {max_date}"
            )

    return prices


def validate_strategy_source(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in ALLOWED_IMPORTS:
                    raise ValueError(f"Disallowed import in strategy.py: {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root not in ALLOWED_IMPORTS:
                raise ValueError(f"Disallowed import in strategy.py: {node.module}")
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_CALLS:
                raise ValueError(f"Disallowed call in strategy.py: {node.func.id}()")
            if isinstance(node.func, ast.Attribute) and node.func.attr in BLOCKED_ATTRS:
                raise ValueError(f"Disallowed pandas/file method in strategy.py: {node.func.attr}()")

    return source


def load_strategy(path: Path):
    source = validate_strategy_source(path)
    original_import = builtins.__import__
    original_open = builtins.open

    def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        if root not in ALLOWED_IMPORTS:
            raise ImportError(f"Strategy import denied: {name}")
        return original_import(name, globals, locals, fromlist, level)

    def safe_open(file, mode="r", *args, **kwargs):
        if any(flag in mode for flag in ("w", "a", "x", "+")):
            raise PermissionError("Strategy file writes are denied")
        return original_open(file, mode, *args, **kwargs)

    safe_builtins = dict(builtins.__dict__)
    safe_builtins["__import__"] = safe_import
    safe_builtins["open"] = safe_open

    module = types.ModuleType("strategy")
    module.__dict__.update({"__builtins__": safe_builtins, "pd": pd, "np": np})
    exec(compile(source, str(path), "exec"), module.__dict__)

    generate_signals = module.__dict__.get("generate_signals")
    if not callable(generate_signals):
        raise ValueError("strategy.py must define generate_signals(prices, params)")
    return generate_signals


def compute_metrics(
    equity: "pd.Series",
    returns: "pd.Series",
    signal: "pd.Series",
    initial_capital: float,
    benchmark_equity: "pd.Series | None",
) -> dict[str, Any]:
    total_return = float(equity.iloc[-1] / initial_capital - 1.0)
    days = max((equity.index[-1] - equity.index[0]).days, 1)
    years = max(days / 365.25, len(equity) / 252.0, 1 / 252)
    annualized_return = float((1.0 + total_return) ** (1.0 / years) - 1.0)
    volatility = float(returns.std(ddof=0) * math.sqrt(252))
    sharpe = float((returns.mean() / returns.std(ddof=0)) * math.sqrt(252)) if returns.std(ddof=0) > 0 else None
    drawdown = equity / equity.cummax() - 1.0

    signal_change = signal.fillna(0).diff().fillna(signal.fillna(0))
    trade_count = int((signal_change != 0).sum())
    invested_days = int((signal.abs() > 0).sum())

    metrics: dict[str, Any] = {
        "total_return": total_return,
        "annualized_return": annualized_return,
        "volatility": volatility,
        "sharpe": sharpe,
        "max_drawdown": float(drawdown.min()),
        "trade_count": trade_count,
        "invested_days": invested_days,
        "initial_capital": initial_capital,
        "ending_equity": float(equity.iloc[-1]),
        "observations": int(len(equity)),
    }

    if benchmark_equity is not None and not benchmark_equity.empty:
        metrics["benchmark_total_return"] = float(
            benchmark_equity.iloc[-1] / benchmark_equity.iloc[0] - 1.0
        )

    return metrics


def storage_root(config: dict[str, Any]) -> Path:
    """Absolute storage/backtests path from the config, or the one beside this runner."""
    default = Path(__file__).resolve().parents[2] / "storage" / "backtests"
    return Path(config.get("storage_root") or default).resolve()


def checked_output_dir(config: dict[str, Any]) -> Path:
    output_dir = Path(config["output_dir"]).resolve()
    storage_root_dir = storage_root(config)
    if storage_root_dir not in output_dir.parents and output_dir != storage_root_dir:
        raise ValueError(f"output_dir must stay under {storage_root_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def price_paths(output_dir: Path) -> tuple[Path, Path]:
    return output_dir / "input" / "asset_prices.csv", output_dir / "input" / "benchmark_prices.csv"


def fetch(config: dict[str, Any]) -> None:
    """Download asset and benchmark prices to CSV. Runs no model-written code."""
    asset_path, benchmark_path = price_paths(checked_output_dir(config))
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    window = (config["start_date"], config.get("end_date"), config.get("market_data_cutoff_at"))
    download_prices(config["symbol"], *window).to_csv(asset_path)
    if config.get("benchmark_symbol"):
        download_prices(config["benchmark_symbol"], *window).to_csv(benchmark_path)


def read_prices(path: Path) -> "pd.DataFrame":
    return pd.read_csv(path, index_col=0, parse_dates=True)


def limit_resources(config: dict[str, Any]) -> None:
    """CPU-time, memory and file-size limits for the strategy. Memory is enforced on Linux, not on macOS."""
    import resource

    limits = {
        "RLIMIT_CPU": int(config.get("cpu_seconds") or 120),
        "RLIMIT_AS": int(config.get("memory_mb") or 4096) * 1024 * 1024,
        "RLIMIT_FSIZE": 256 * 1024 * 1024,
    }
    for name, value in limits.items():
        try:
            resource.setrlimit(getattr(resource, name), (value, value))
        except (ValueError, OSError, AttributeError):
            pass


def run(config: dict[str, Any], fetched: bool = False) -> dict[str, Any]:
    output_dir = checked_output_dir(config)
    if not fetched:
        fetch(config)

    symbol = config["symbol"]
    benchmark_symbol = config.get("benchmark_symbol")
    asset_path, benchmark_path = price_paths(output_dir)
    # Both series are read before strategy code runs, so it can't rewrite the CSVs first. It runs
    # in this process, though, and can still reach these frames or patch the code below: the
    # sandbox protects the host, not the integrity of the results.
    prices = read_prices(asset_path)
    benchmark_prices = read_prices(benchmark_path) if benchmark_symbol else None

    limit_resources(config)
    generate_signals = load_strategy(Path(config["strategy_path"]).resolve())
    signals = generate_signals(prices.copy(), config.get("params") or {})
    if isinstance(signals, pd.Series):
        signals = signals.to_frame("signal")
    if not isinstance(signals, pd.DataFrame) or "signal" not in signals.columns:
        raise ValueError("generate_signals must return a DataFrame with a signal column")

    signal = pd.to_numeric(signals["signal"], errors="coerce")
    signal = signal.reindex(prices.index).ffill().fillna(0.0).clip(-1.0, 1.0)
    close = pd.to_numeric(prices.get("adj_close", prices["close"]), errors="coerce").ffill()
    raw_returns = close.pct_change().fillna(0.0)
    strategy_returns = signal.shift(1).fillna(0.0) * raw_returns

    initial_capital = float(config.get("initial_capital") or 100000)
    equity = initial_capital * (1.0 + strategy_returns).cumprod()

    benchmark_equity = None
    if benchmark_prices is not None:
        benchmark_close = pd.to_numeric(
            benchmark_prices.get("adj_close", benchmark_prices["close"]),
            errors="coerce",
        ).ffill()
        benchmark_returns = benchmark_close.pct_change().fillna(0.0)
        benchmark_equity = initial_capital * (1.0 + benchmark_returns).cumprod()
        benchmark_equity = benchmark_equity.reindex(equity.index).ffill()

    metrics = compute_metrics(
        equity,
        strategy_returns,
        signal,
        initial_capital,
        benchmark_equity,
    )
    metrics.update(
        {
            "symbol": symbol,
            "benchmark_symbol": benchmark_symbol,
            "start_date": prices.index.min().date().isoformat(),
            "end_date": prices.index.max().date().isoformat(),
            "data_provider": "yfinance",
        }
    )

    equity_frame = pd.DataFrame(
        {
            "date": equity.index.date.astype(str),
            "price": close.values,
            "signal": signal.values,
            "strategy_return": strategy_returns.values,
            "equity": equity.values,
        }
    )
    if benchmark_equity is not None:
        equity_frame["benchmark_equity"] = benchmark_equity.values

    signal_change = signal.fillna(0).diff().fillna(signal.fillna(0))
    trades = pd.DataFrame(
        {
            "date": signal.index[signal_change != 0].date.astype(str),
            "price": close.loc[signal_change != 0].values,
            "new_signal": signal.loc[signal_change != 0].values,
            "signal_change": signal_change.loc[signal_change != 0].values,
        }
    )

    root = storage_root(config)
    metrics_path = output_dir / "metrics.json"
    equity_path = output_dir / "equity_curve.csv"
    trades_path = output_dir / "trades.csv"
    log_path = output_dir / "runner.log"

    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True), encoding="utf-8")
    equity_frame.to_csv(equity_path, index=False)
    trades.to_csv(trades_path, index=False)
    log_path.write_text(
        "\n".join(
            [
                f"symbol={symbol}",
                f"benchmark_symbol={benchmark_symbol or ''}",
                f"rows={len(prices)}",
                f"strategy_path={config['strategy_path']}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    artifacts = [
        {
            "artifact_type": "metrics",
            "title": "metrics.json",
            "storage_path": rel_path(metrics_path, root),
            "mime_type": "application/json",
            "metadata_json": {},
        },
        {
            "artifact_type": "equity_curve",
            "title": "equity_curve.csv",
            "storage_path": rel_path(equity_path, root),
            "mime_type": "text/csv",
            "metadata_json": {"rows": len(equity_frame)},
        },
        {
            "artifact_type": "trades",
            "title": "trades.csv",
            "storage_path": rel_path(trades_path, root),
            "mime_type": "text/csv",
            "metadata_json": {"rows": len(trades)},
        },
        {
            "artifact_type": "runner_log",
            "title": "runner.log",
            "storage_path": rel_path(log_path, root),
            "mime_type": "text/plain",
            "metadata_json": {},
        },
    ]

    return {"metrics": metrics, "artifacts": artifacts}


def main() -> int:
    args = sys.argv[1:]
    mode = args.pop(0) if len(args) == 2 and args[0] in ("fetch", "run") else "all"
    if len(args) != 1:
        print("Usage: run_backtest.py [fetch|run] <runner-input.json>", file=sys.stderr)
        return 2

    config_path = Path(args[0])
    config = json.loads(config_path.read_text(encoding="utf-8"))

    try:
        if mode == "fetch":
            fetch(config)
        else:
            print(json.dumps(run(config, fetched=mode == "run"), separators=(",", ":")))
        return 0
    except Exception as exc:
        output_dir = Path(config.get("output_dir", ".")).resolve()
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "runner.log").write_text(f"Backtest failed: {exc}\n", encoding="utf-8")
        except Exception:
            pass
        print(f"Backtest failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
