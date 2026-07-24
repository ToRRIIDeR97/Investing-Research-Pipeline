/**
 * Source role constants and hierarchy for Research OS v3.
 */

export const SOURCE_ROLES = [
  "regulatory_filing",
  "company_investor_relations",
  "earnings_release",
  "earnings_presentation",
  "earnings_transcript",
  "proxy_and_governance",
  "founder_and_company_history",
  "peer_company_primary",
  "industry_primary",
  "customer_or_channel",
  "supplier_or_partner",
  "regulatory_or_government",
  "macro_dataset",
  "market_data",
] as const;

export type SourceRole = (typeof SOURCE_ROLES)[number];

export const SOURCE_ROLE_HIERARCHY: SourceRole[] = [
  "regulatory_filing",
  "company_investor_relations",
  "earnings_release",
  "earnings_presentation",
  "earnings_transcript",
  "proxy_and_governance",
  "founder_and_company_history",
  "peer_company_primary",
  "industry_primary",
  "customer_or_channel",
  "supplier_or_partner",
  "regulatory_or_government",
  "macro_dataset",
  "market_data",
];

export const SOURCE_ROLE_RANK: Record<SourceRole, number> = Object.fromEntries(
  SOURCE_ROLE_HIERARCHY.map((role, index) => [role, index])
) as Record<SourceRole, number>;

export function isValidSourceRole(role: string): role is SourceRole {
  return SOURCE_ROLES.includes(role as SourceRole);
}

export function sourceRoleRank(role: SourceRole): number {
  return SOURCE_ROLE_RANK[role] ?? 999;
}

export function compareSourceRoles(a: SourceRole, b: SourceRole): number {
  return sourceRoleRank(a) - sourceRoleRank(b);
}

export const REQUIRED_SOURCE_ROLES_FOR_INITIATION: SourceRole[] = [
  "regulatory_filing",
  "company_investor_relations",
  "earnings_release",
  "founder_and_company_history",
  "peer_company_primary",
  "industry_primary",
  "market_data",
];

export const SECONDARY_SOURCE_ROLES: SourceRole[] = [
  "earnings_presentation",
  "earnings_transcript",
  "proxy_and_governance",
  "customer_or_channel",
  "supplier_or_partner",
  "regulatory_or_government",
  "macro_dataset",
];
