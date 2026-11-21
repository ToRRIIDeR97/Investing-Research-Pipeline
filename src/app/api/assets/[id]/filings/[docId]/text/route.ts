import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/api/errors";
import { filingDownload, requireFilingsAsset } from "@/lib/api/filings";

type Params = { params: Promise<{ id: string; docId: string }> };

/** The filing as plain text (no HTML), as a download. */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { id, docId } = await params;
    const { text, filename } = await filingDownload(await requireFilingsAsset(id), docId);
    return new Response(text, { status: 200, headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    } });
  } catch (error) {
    return handleApiError(error);
  }
}
