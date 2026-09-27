/** Resolve the projection's own denominator in millions; never invent one. */
export function projectionSharesInMillions(balance: Record<string, any>, reportedMillions: number): number {
  const equity = Number(balance.equity_base ?? balance.equity_usd_millions?.base);
  const bookValue = Number(balance.book_value_per_share_base ?? balance.book_value_per_diluted_share?.base);
  const implied = equity / bookValue;
  const rawShares = balance.diluted_shares ?? balance.shares_outstanding;
  const explicit = balance.diluted_shares_millions ?? balance.shares_outstanding_millions ??
    (rawShares == null ? undefined : Number(rawShares) / 1e6) ?? balance.reported_diluted_shares;
  const shares = Number(explicit ?? (
    Number.isFinite(implied) && Math.abs(implied / reportedMillions - 1) < 0.001 ? reportedMillions : implied
  ));
  if (!Number.isFinite(shares) || !(shares > 0)) throw new Error("Valuation projection lacks a positive finite share denominator");
  return shares;
}

export function projectionShareUnitErrors(projections: any[]): Array<{ path: string; message: string }> {
  return projections.flatMap((projection, index) => {
    const balance = projection.balance_sheet_values || {};
    const millions = balance.diluted_shares_millions ?? balance.shares_outstanding_millions;
    const path = `annual_price_target_path.annual_projections.${index}.balance_sheet_values`;
    if (typeof millions !== 'number' || !Number.isFinite(millions) || millions <= 0) {
      return [{ path, message: 'Provide a positive diluted_shares_millions or shares_outstanding_millions; unlabelled share units are ambiguous.' }];
    }
    for (const key of ['diluted_shares', 'shares_outstanding', 'diluted_shares_millions', 'shares_outstanding_millions']) {
      if (balance[key] == null) continue;
      const value = Number(balance[key]) / (key.endsWith('_millions') ? 1 : 1e6);
      if (!Number.isFinite(value) || Math.abs(value / millions - 1) > 0.001) {
        return [{ path: `${path}.${key}`, message: 'Raw share fields must be actual share counts and agree with the explicitly labelled millions denominator.' }];
      }
    }
    return [];
  });
}
