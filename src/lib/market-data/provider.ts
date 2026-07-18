/**
 * Provider-neutral market-data contract for Research OS v3.
 */

export type MarketQuote = {
  symbol: string;
  price: number;
  currency: string;
  marketCap?: number;
  volume?: number;
  week52High?: number;
  week52Low?: number;
  asOf: Date;
};

export type PriceBar = {
  trading_date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  adjusted_close?: number;
  volume?: number;
  currency: string;
  exchange_timezone?: string;
};

export type CorporateActionEvent = {
  action_type: "dividend" | "split" | "spinoff" | "symbol_change";
  ex_date?: Date;
  record_date?: Date;
  pay_date?: Date;
  dividend_per_share?: number;
  split_ratio?: number;
  spinoff_ratio?: number;
  old_symbol?: string;
  new_symbol?: string;
  currency?: string;
};

export type InstrumentMetadata = {
  symbol: string;
  currency: string;
  exchange?: string;
  timezone?: string;
  instrument_type?: string;
  name?: string;
};

export interface MarketDataProvider {
  getName(): string;
  getQuote(symbol: string, asOf?: Date): Promise<MarketQuote>;
  getPriceHistory(
    symbol: string,
    start: Date,
    end: Date,
    interval: "1d" | "1wk" | "1mo"
  ): Promise<PriceBar[]>;
  getCorporateActions(
    symbol: string,
    start: Date,
    end: Date
  ): Promise<CorporateActionEvent[]>;
  getInstrumentMetadata(symbol: string): Promise<InstrumentMetadata>;
}

export class MarketDataError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly code: "rate_limited" | "not_found" | "parse_error" | "network_error" | "unknown"
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}
