import { NextRequest } from "next/server";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";
import { normalizeQuery, searchListedCompanies } from "@/lib/market-data/company-search";

/**
 * GET /api/market-search?q=
 * Listed companies from Yahoo Finance for the Start research search bar. Returns 502 with
 * YAHOO_UNAVAILABLE when Yahoo can't be reached, so the page can offer adding a ticker by hand.
 */
export async function GET(request: NextRequest) {
  try {
    const q = normalizeQuery(new URL(request.url).searchParams.get("q"));
    if (!q) return successResponse([]);
    let results;
    try {
      results = await searchListedCompanies(q);
    } catch {
      throw new ApiError("Yahoo Finance search is unavailable", 502, "YAHOO_UNAVAILABLE");
    }
    return successResponse(results);
  } catch (error) {
    return handleApiError(error);
  }
}
