import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

/** Create a raw SQL fragment for JSONB insertion */
function jsonbSql(value: unknown) {
  return sql.unsafe("'" + JSON.stringify(value) + "'");
}

// ── Stable UUIDs (deterministic per run) ────────────────────────────
function stableId(namespace: string, key: string): string {
  // Use crypto.randomUUID() seeded deterministically for reproducibility.
  // For simplicity we generate fresh UUIDs on first run and rely on
  // ON CONFLICT DO NOTHING for idempotency on subsequent runs.
  return crypto.randomUUID();
}

// ── Research Profiles ───────────────────────────────────────────────

interface ProfileSeed {
  profile_key: string;
  name: string;
  version: number;
  asset_kinds: string[];
  description: string;
  required_modules: string[];
  optional_modules: string[];
  forbidden_methods: string[];
  required_valuation_lenses: string[];
  completion_criteria: Record<string, unknown>;
}

const profiles: ProfileSeed[] = [
  {
    profile_key: "operating_company",
    name: "Operating Company",
    version: 1,
    asset_kinds: ["equity"],
    description:
      "Full research profile for operating companies — includes driver-based valuation, unit economics, ROIC, free cash flow, and multiple DCF approaches.",
    required_modules: [
      "business_segments",
      "revenue_drivers",
      "unit_economics",
      "margins",
      "roic",
      "fcf",
      "capex",
      "working_capital",
      "net_debt",
      "share_count",
      "driver_based_dcf",
      "exit_multiple_dcf",
      "reverse_dcf",
    ],
    optional_modules: [],
    forbidden_methods: ["generic_revenue_growth", "single_multiple_cheapness"],
    required_valuation_lenses: ["dcf", "multiple", "cash_flow"],
    completion_criteria: {
      required_modules: [
        "business_segments",
        "revenue_drivers",
        "margins",
        "fcf",
        "capex",
        "working_capital",
        "share_count",
        "net_debt",
        "driver_based_dcf",
        "reverse_dcf",
        "peer_multiple_context",
      ],
      required_value_anchors: ["bear", "base", "bull"],
      required_source_families: ["filing", "investor_relations", "peer_industry"],
    },
  },
  {
    profile_key: "bitcoin",
    name: "Bitcoin",
    version: 1,
    asset_kinds: ["crypto_asset"],
    description:
      "Crypto-native research profile for Bitcoin — on-chain metrics, network security, ETF flows, liquidity cycles, and regulatory regime analysis.",
    required_modules: [
      "mvrv",
      "realized_price",
      "drawdown",
      "network_value",
      "hash_rate",
      "security_budget",
      "etf_flows",
      "liquidity_cycle",
      "btc_dominance",
      "btc_gold_ratio",
      "regulatory_regime",
    ],
    optional_modules: [],
    forbidden_methods: ["dcf"],
    required_valuation_lenses: ["crypto_onchain"],
    completion_criteria: {
      required_modules: [
        "mvrv",
        "realized_price",
        "drawdown",
        "network_value",
        "hash_rate",
        "etf_flows",
        "liquidity_cycle",
        "regulatory_regime",
      ],
      required_value_anchors: ["cycle_low", "base_cycle", "cycle_high"],
      required_source_families: ["onchain_data", "market_data", "regulatory"],
    },
  },
  {
    profile_key: "commodity_energy",
    name: "Commodity / Energy",
    version: 1,
    asset_kinds: ["commodity"],
    description:
      "Commodity and energy research profile — real price percentiles, supply/demand fundamentals, futures curve structure, OPEC dynamics, and geopolitical risk.",
    required_modules: [
      "real_price_percentile",
      "inventories",
      "days_of_supply",
      "futures_curve",
      "roll_yield",
      "marginal_cost",
      "spare_capacity",
      "opec_discipline",
      "rig_count",
      "demand_growth",
      "geopolitical_risk",
    ],
    optional_modules: [],
    forbidden_methods: ["equity_dcf_for_spot"],
    required_valuation_lenses: ["commodity"],
    completion_criteria: {
      required_modules: [
        "real_price_percentile",
        "inventories",
        "futures_curve",
        "marginal_cost",
        "spare_capacity",
        "demand_growth",
      ],
      required_value_anchors: ["bear", "base", "bull"],
      required_source_families: ["market_data", "supply_demand", "macro"],
    },
  },
  {
    profile_key: "financials",
    name: "Financials",
    version: 1,
    asset_kinds: ["equity"],
    description:
      "Bank and financial-institution profile — tangible book value, capital ratios, NIM, credit losses, and residual-income valuation.",
    required_modules: [
      "tangible_book_value",
      "ptbv",
      "roe_vs_coe",
      "roa",
      "nim",
      "credit_losses",
      "cet1",
      "deposit_mix",
      "book_value_growth",
      "buyback_capacity",
    ],
    optional_modules: [],
    forbidden_methods: ["ev_ebitda"],
    required_valuation_lenses: ["residual_income"],
    completion_criteria: {
      required_modules: [
        "tangible_book_value",
        "roe_vs_coe",
        "nim",
        "credit_losses",
        "cet1",
        "deposit_mix",
        "funding_mix",
        "residual_income_valuation",
      ],
      required_value_anchors: ["bear", "base", "bull"],
      required_source_families: ["filing", "regulatory", "peer_industry"],
    },
  },
  {
    profile_key: "etf_fund",
    name: "ETF / Fund",
    version: 1,
    asset_kinds: ["fund"],
    description:
      "ETF and pooled-fund profile — aggregate valuation, concentration risk, fund flows, tracking error, and NAV premium/discount analysis.",
    required_modules: [
      "aggregate_pe",
      "cape",
      "price_to_book",
      "earnings_yield_vs_bonds",
      "dividend_yield",
      "buyback_yield",
      "sector_concentration",
      "top_10_concentration",
      "fund_flows",
      "expense_ratio",
      "tracking_error",
      "nav_discount_premium",
    ],
    optional_modules: [],
    forbidden_methods: [],
    required_valuation_lenses: ["multiple"],
    completion_criteria: {
      required_modules: [
        "nav",
        "nav_per_share",
        "discount_premium_to_nav",
        "portfolio_composition",
        "leverage",
        "buybacks",
        "capital_allocation",
      ],
      required_value_anchors: ["bear", "base", "bull"],
      required_source_families: ["issuer_report", "market_data", "portfolio_holdings"],
    },
  },
];

// ── Valuation Methods ───────────────────────────────────────────────

interface MethodSeed {
  method_key: string;
  name: string;
  method_family: string;
  description: string;
  applicable_profile_keys: string[];
  forbidden_profile_keys: string[];
}

const methods: MethodSeed[] = [
  {
    method_key: "driver_based_dcf",
    name: "Driver-Based DCF",
    method_family: "dcf",
    description:
      "Discounted cash flow built from explicit operating drivers (revenue build, margin assumptions, reinvestment needs).",
    applicable_profile_keys: ["operating_company"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "exit_multiple_dcf",
    name: "Exit Multiple DCF",
    method_family: "dcf",
    description:
      "DCF that terminates in a terminal value derived from an exit multiple rather than a perpetuity growth rate.",
    applicable_profile_keys: ["operating_company"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "reverse_dcf",
    name: "Reverse DCF",
    method_family: "dcf",
    description:
      "Infers the growth and margin expectations implied by the current market price.",
    applicable_profile_keys: ["operating_company"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "pe_multiple",
    name: "P/E Multiple",
    method_family: "multiple",
    description:
      "Price-to-earnings multiple analysis against historical range and peer comparison.",
    applicable_profile_keys: ["operating_company", "etf_fund"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "ev_ebitda",
    name: "EV/EBITDA",
    method_family: "multiple",
    description:
      "Enterprise value to EBITDA multiple — capital-structure-neutral relative valuation.",
    applicable_profile_keys: ["operating_company"],
    forbidden_profile_keys: ["financials"],
  },
  {
    method_key: "ptbv_roe_coe",
    name: "Price-to-Tangible Book vs ROE-COE",
    method_family: "residual_income",
    description:
      "Residual income approach: compares price-to-tangible-book-value against the spread between ROE and cost of equity.",
    applicable_profile_keys: ["financials"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "nav_discount",
    name: "NAV Discount/Premium",
    method_family: "nav",
    description:
      "Measures the discount or premium of market price to net asset value.",
    applicable_profile_keys: ["etf_fund"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "mvrv_percentile",
    name: "MVRV Percentile",
    method_family: "crypto_onchain",
    description:
      "Market-value-to-realized-value ratio evaluated against its historical distribution.",
    applicable_profile_keys: ["bitcoin"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "realized_price_drawdown",
    name: "Realized Price Drawdown",
    method_family: "crypto_onchain",
    description:
      "Drawdown from realized price as a valuation anchor for Bitcoin cycles.",
    applicable_profile_keys: ["bitcoin"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "sum_of_the_parts",
    name: "Sum of the Parts",
    method_family: "composite",
    description:
      "Values each business segment independently and aggregates with adjustments for corporate-level items.",
    applicable_profile_keys: ["operating_company"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "probability_weighted_value",
    name: "Probability-Weighted Value",
    method_family: "special",
    description:
      "Assigns probabilities to discrete scenarios and computes an expected value.",
    applicable_profile_keys: ["operating_company"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "cap_rate_spread",
    name: "Cap Rate Spread",
    method_family: "real_estate",
    description:
      "Implied cap rate minus benchmark rate for REIT/infrastructure valuation.",
    applicable_profile_keys: ["reit_infrastructure"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "stock_to_use_percentile",
    name: "Stock-to-Use Percentile",
    method_family: "commodity",
    description:
      "Stock-to-use ratio evaluated against historical distribution for agriculture commodity valuation.",
    applicable_profile_keys: ["commodity_agriculture"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "real_price_percentile",
    name: "Real Price Percentile",
    method_family: "commodity",
    description:
      "Inflation-adjusted price evaluated against its long-term historical distribution.",
    applicable_profile_keys: ["commodity_energy", "commodity_industrial", "commodity_agriculture", "precious_metals"],
    forbidden_profile_keys: [],
  },
  {
    method_key: "gold_m2_ratio",
    name: "Gold/M2 Ratio",
    method_family: "precious_metals",
    description:
      "Gold price relative to broad money supply as a store-of-value metric.",
    applicable_profile_keys: ["precious_metals"],
    forbidden_profile_keys: [],
  },
];

// ── Assets ──────────────────────────────────────────────────────────

interface AssetSeed {
  canonical_name: string;
  slug: string;
  asset_kind: string;
  base_currency: string;
  home_country: string;
  sector: string | null;
  industry: string | null;
  description: string;
}

const assets: AssetSeed[] = [
  {
    canonical_name: "Apple Inc.",
    slug: "apple",
    asset_kind: "equity",
    base_currency: "USD",
    home_country: "US",
    sector: "Technology",
    industry: "Consumer Electronics",
    description:
      "Apple Inc. designs, manufactures, and markets smartphones, personal computers, tablets, wearables, and accessories worldwide.",
  },
  {
    canonical_name: "Bitcoin",
    slug: "bitcoin",
    asset_kind: "crypto_asset",
    base_currency: "USD",
    home_country: "Global",
    sector: null,
    industry: null,
    description:
      "Bitcoin is a decentralized digital currency using proof-of-work consensus, with a fixed supply cap of 21 million coins.",
  },
];

// ── Seed Logic ──────────────────────────────────────────────────────

async function seed(): Promise<void> {
  console.log("=== Research OS — Database Seed ===\n");

  // ── 1. Research Profiles ──────────────────────────────────────────
  console.log("[1/5] Seeding research_profiles …");

  const profileIdByKeyVersion: Record<string, string> = {};

  for (const p of profiles) {
    const profileKey = `${p.profile_key}_v${p.version}`;

    // A rerun (or a store-imported database) already has the row: RETURNING gives its id, not a fresh one.
    const [{ id }] = await sql`
      INSERT INTO research_profiles (
        id, profile_key, name, version, status, asset_kinds,
        description, required_modules_json, optional_modules_json,
        forbidden_methods_json, required_valuation_lenses_json,
        required_scenario_drivers_json, completion_criteria_json,
        validator_config_json, created_at, updated_at
      ) VALUES (
        ${crypto.randomUUID()},
        ${p.profile_key},
        ${p.name},
        ${p.version},
        'active',
        ${p.asset_kinds},
        ${p.description},
        ${jsonbSql(p.required_modules)},
        ${jsonbSql(p.optional_modules)},
        ${jsonbSql(p.forbidden_methods)},
        ${jsonbSql(p.required_valuation_lenses)},
        ${jsonbSql([])},
        ${jsonbSql(p.completion_criteria)},
        ${jsonbSql({})},
        NOW(),
        NOW()
      )
      ON CONFLICT (profile_key, version) DO UPDATE SET profile_key = EXCLUDED.profile_key
      RETURNING id
    `;
    profileIdByKeyVersion[profileKey] = id;

    console.log(`   ${p.profile_key} v${p.version} -> ${id}`);
  }

  // ── 2. Valuation Methods ──────────────────────────────────────────
  console.log("\n[2/5] Seeding valuation_methods …");

  for (const m of methods) {
    const [{ id }] = await sql`
      INSERT INTO valuation_methods (
        id, method_key, name, method_family, description,
        applicable_profile_keys, forbidden_profile_keys,
        requires_code, requires_market_data, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${crypto.randomUUID()},
        ${m.method_key},
        ${m.name},
        ${m.method_family},
        ${m.description},
        ${m.applicable_profile_keys},
        ${m.forbidden_profile_keys},
        false,
        false,
        ${jsonbSql({})},
        NOW(),
        NOW()
      )
      ON CONFLICT (method_key) DO UPDATE SET method_key = EXCLUDED.method_key
      RETURNING id
    `;

    console.log(`   ${m.method_key} (${m.method_family}) -> ${id}`);
  }

  // ── 3. Assets ─────────────────────────────────────────────────────
  console.log("\n[3/5] Seeding assets …");

  const assetIdBySlug: Record<string, string> = {};

  for (const a of assets) {
    const [{ id }] = await sql`
      INSERT INTO assets (
        id, canonical_name, slug, asset_kind, base_currency,
        home_country, sector, industry, description, status,
        created_at, updated_at
      ) VALUES (
        ${crypto.randomUUID()},
        ${a.canonical_name},
        ${a.slug},
        ${a.asset_kind},
        ${a.base_currency},
        ${a.home_country},
        ${a.sector},
        ${a.industry},
        ${a.description},
        'active',
        NOW(),
        NOW()
      )
      ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
      RETURNING id
    `;
    assetIdBySlug[a.slug] = id;

    console.log(`   ${a.canonical_name} (${a.slug}) -> ${id}`);
  }

  // ── 3b. Asset-Profile Linkage ───────────────────────────────────
  console.log("\n[3b] Linking assets to research profiles …");

  const profileLinkages = [
    { assetSlug: "apple", profileKey: "operating_company" },
    { assetSlug: "bitcoin", profileKey: "bitcoin" },
  ];

  for (const link of profileLinkages) {
    const assetId = assetIdBySlug[link.assetSlug];
    // Find the profile ID for this key (any version)
    const profileEntry = Object.entries(profileIdByKeyVersion).find(([k]) =>
      k.startsWith(link.profileKey)
    );
    if (assetId && profileEntry) {
      const profileId = profileEntry[1];

      // Set primary_profile_id on asset
      await sql`
        UPDATE assets SET primary_profile_id = ${profileId} WHERE id = ${assetId}
      `;

      // Create asset_profile_assignments record (once: the table has no unique key to conflict on)
      const [assignment] = await sql`
        SELECT id FROM asset_profile_assignments WHERE asset_id = ${assetId} AND profile_id = ${profileId} LIMIT 1
      `;
      await sql`
        INSERT INTO asset_profile_assignments (
          id, asset_id, profile_id, assignment_reason,
          assigned_by, status, created_at
        ) VALUES (
          ${assignment?.id ?? crypto.randomUUID()},
          ${assetId},
          ${profileId},
          'Initial seed assignment',
          'seed',
          'active',
          NOW()
        )
        ON CONFLICT (id) DO NOTHING
      `;

      console.log(`   ${link.assetSlug} -> ${link.profileKey}`);
    }
  }

  // ── 4. Instruments ────────────────────────────────────────────────
  console.log("\n[4/5] Seeding instruments …");

  // Instruments and listings have no natural unique key, so a rerun reuses the rows it finds instead of adding copies.
  const existingId = async (rows: Promise<Array<{ id: string }>>) => (await rows)[0]?.id ?? crypto.randomUUID();
  const aaplInstrumentId = await existingId(sql`SELECT id FROM instruments
    WHERE asset_id = ${assetIdBySlug["apple"]} AND instrument_type = 'common_stock' LIMIT 1`);
  const btcInstrumentId = await existingId(sql`SELECT id FROM instruments
    WHERE asset_id = ${assetIdBySlug["bitcoin"]} AND instrument_type = 'crypto' LIMIT 1`);

  await sql`
    INSERT INTO instruments (
      id, asset_id, instrument_type, name, currency,
      contract_specs_json, created_at, updated_at
    ) VALUES (
      ${aaplInstrumentId},
      ${assetIdBySlug["apple"]},
      'common_stock',
      'Apple Inc. Common Stock',
      'USD',
      ${jsonbSql({})},
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  console.log(`   Apple common stock -> ${aaplInstrumentId}`);

  await sql`
    INSERT INTO instruments (
      id, asset_id, instrument_type, name, currency,
      contract_specs_json, created_at, updated_at
    ) VALUES (
      ${btcInstrumentId},
      ${assetIdBySlug["bitcoin"]},
      'crypto',
      'Bitcoin',
      'USD',
      '{"base":"BTC","quote":"USD"}'::jsonb,
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  console.log(`   Bitcoin crypto instrument -> ${btcInstrumentId}`);

  // ── 5. Listings ───────────────────────────────────────────────────
  console.log("\n[5/5] Seeding listings …");

  // AAPL on NASDAQ
  const listingId = (instrumentId: string, symbol: string, exchange: string) => existingId(sql`SELECT id FROM listings
    WHERE instrument_id = ${instrumentId} AND symbol = ${symbol} AND exchange = ${exchange} LIMIT 1`);
  const aaplNasdaqId = await listingId(aaplInstrumentId, "AAPL", "NASDAQ");
  await sql`
    INSERT INTO listings (
      id, instrument_id, symbol, exchange, mic, currency,
      listing_type, is_primary, created_at, metadata_json
    ) VALUES (
      ${aaplNasdaqId},
      ${aaplInstrumentId},
      'AAPL',
      'NASDAQ',
      'XNAS',
      'USD',
      'equity',
      true,
      NOW(),
      ${jsonbSql({})}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  console.log(`   AAPL / NASDAQ (primary) -> ${aaplNasdaqId}`);

  // BTC on Coinbase
  const btcCoinbaseId = await listingId(btcInstrumentId, "BTC", "Coinbase");
  await sql`
    INSERT INTO listings (
      id, instrument_id, symbol, exchange, mic, currency,
      listing_type, is_primary, created_at, metadata_json
    ) VALUES (
      ${btcCoinbaseId},
      ${btcInstrumentId},
      'BTC',
      'Coinbase',
      null,
      'USD',
      'crypto',
      true,
      NOW(),
      ${jsonbSql({})}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  console.log(`   BTC / Coinbase (primary) -> ${btcCoinbaseId}`);

  // BTC on Binance
  const btcBinanceId = await listingId(btcInstrumentId, "BTC", "Binance");
  await sql`
    INSERT INTO listings (
      id, instrument_id, symbol, exchange, mic, currency,
      listing_type, is_primary, created_at, metadata_json
    ) VALUES (
      ${btcBinanceId},
      ${btcInstrumentId},
      'BTC',
      'Binance',
      null,
      'USD',
      'crypto',
      false,
      NOW(),
      ${jsonbSql({})}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  console.log(`   BTC / Binance -> ${btcBinanceId}`);

  console.log("\n=== Seed complete ===");
}

// ── Run ─────────────────────────────────────────────────────────────
seed()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => {
    sql.end();
  });
