import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema/core";
import { note_blocks, notebooks } from "@/db/schema/thesis";
import { ApiError } from "@/lib/api/errors";
import { chartViewConfigSchema, type ChartViewConfig } from "./config";

export const CHART_WORKSPACE_TYPE = "chart_workspace";
export const CHART_BLOCK_TYPE = "chart";
const WORKSPACE_AUTHOR = "workspace";

export type SavedChartView = {
  id: string;
  notebookId: string;
  name: string;
  config: ChartViewConfig;
  createdAt: string;
  updatedAt: string;
};

export async function assertAssetExists(assetId: string) {
  const [asset] = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new ApiError("Asset not found", 404, "ASSET_NOT_FOUND");
}

export async function listSavedChartViews(assetId: string): Promise<SavedChartView[]> {
  const rows = await db
    .select({
      id: note_blocks.id,
      notebookId: notebooks.id,
      content: note_blocks.content_json,
      createdAt: note_blocks.created_at,
      updatedAt: note_blocks.updated_at,
    })
    .from(note_blocks)
    .innerJoin(notebooks, eq(note_blocks.notebook_id, notebooks.id))
    .where(
      and(
        eq(notebooks.asset_id, assetId),
        eq(notebooks.notebook_type, CHART_WORKSPACE_TYPE),
        eq(note_blocks.block_type, CHART_BLOCK_TYPE),
      ),
    )
    .orderBy(asc(note_blocks.block_order));

  return rows.flatMap((row) => {
    const parsed = chartViewConfigSchema.safeParse(row.content);
    if (!parsed.success) return [];
    return [{
      id: row.id,
      notebookId: row.notebookId,
      name: parsed.data.name,
      config: parsed.data,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }];
  });
}

export async function getSavedChartView(assetId: string, blockId: string): Promise<SavedChartView> {
  const [row] = await db
    .select({
      id: note_blocks.id,
      notebookId: notebooks.id,
      content: note_blocks.content_json,
      createdAt: note_blocks.created_at,
      updatedAt: note_blocks.updated_at,
    })
    .from(note_blocks)
    .innerJoin(notebooks, eq(note_blocks.notebook_id, notebooks.id))
    .where(
      and(
        eq(note_blocks.id, blockId),
        eq(notebooks.asset_id, assetId),
        eq(notebooks.notebook_type, CHART_WORKSPACE_TYPE),
        eq(note_blocks.block_type, CHART_BLOCK_TYPE),
      ),
    )
    .limit(1);
  if (!row) throw new ApiError("Saved chart view not found", 404, "CHART_VIEW_NOT_FOUND");
  const config = chartViewConfigSchema.safeParse(row.content);
  if (!config.success) throw new ApiError("Saved chart view is invalid", 500, "INVALID_SAVED_CHART");
  return {
    id: row.id,
    notebookId: row.notebookId,
    name: config.data.name,
    config: config.data,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function saveChartView(assetId: string, input: unknown): Promise<SavedChartView> {
  const config = chartViewConfigSchema.parse(input);
  if (config.anchorAssetId !== assetId) {
    throw new ApiError("Saved chart must belong to its anchor asset", 400, "CHART_ASSET_MISMATCH");
  }
  await assertChartAssets(config.assetIds);
  const workspace = await getOrCreateWorkspace(assetId);
  const [nextOrder] = await db
    .select({ value: max(note_blocks.block_order) })
    .from(note_blocks)
    .where(eq(note_blocks.notebook_id, workspace.id));
  const [block] = await db
    .insert(note_blocks)
    .values({
      notebook_id: workspace.id,
      block_order: Number(nextOrder?.value ?? -1) + 1,
      block_type: CHART_BLOCK_TYPE,
      content_json: config as unknown as Record<string, unknown>,
      created_by: WORKSPACE_AUTHOR,
    })
    .returning();
  await db.update(notebooks).set({ updated_at: new Date() }).where(eq(notebooks.id, workspace.id));
  return getSavedChartView(assetId, block.id);
}

export async function updateChartView(
  assetId: string,
  blockId: string,
  input: { config?: unknown; name?: unknown },
): Promise<SavedChartView> {
  const existing = await getSavedChartView(assetId, blockId);
  let config = existing.config;
  if (input.config !== undefined) config = chartViewConfigSchema.parse(input.config);
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new ApiError("Chart name must not be empty", 400, "INVALID_CHART_NAME");
    }
    config = chartViewConfigSchema.parse({ ...config, name: input.name });
  }
  if (config.anchorAssetId !== assetId) throw new ApiError("Saved chart must belong to its anchor asset", 400, "CHART_ASSET_MISMATCH");
  await assertChartAssets(config.assetIds);
  const [updated] = await db
    .update(note_blocks)
    .set({ content_json: config as unknown as Record<string, unknown>, updated_at: new Date() })
    .where(eq(note_blocks.id, existing.id))
    .returning();
  await db.update(notebooks).set({ updated_at: new Date() }).where(eq(notebooks.id, existing.notebookId));
  if (!updated) throw new ApiError("Saved chart view not found", 404, "CHART_VIEW_NOT_FOUND");
  return getSavedChartView(assetId, blockId);
}

export async function deleteChartView(assetId: string, blockId: string) {
  const existing = await getSavedChartView(assetId, blockId);
  await db.delete(note_blocks).where(eq(note_blocks.id, existing.id));
  await db.update(notebooks).set({ updated_at: new Date() }).where(eq(notebooks.id, existing.notebookId));
  return { deleted: true, id: blockId };
}

async function getOrCreateWorkspace(assetId: string) {
  const [existing] = await db
    .select({ id: notebooks.id })
    .from(notebooks)
    .where(and(eq(notebooks.asset_id, assetId), eq(notebooks.notebook_type, CHART_WORKSPACE_TYPE)))
    .orderBy(desc(notebooks.updated_at))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(notebooks)
    .values({
      asset_id: assetId,
      title: "Chart workspace",
      notebook_type: CHART_WORKSPACE_TYPE,
      created_by: WORKSPACE_AUTHOR,
    })
    .returning({ id: notebooks.id });
  return created;
}

async function assertChartAssets(assetIds: string[]) {
  const rows = await db.select({ id: assets.id }).from(assets).where(inArray(assets.id, assetIds));
  if (rows.length !== new Set(assetIds).size) throw new ApiError("Saved chart references an unknown asset", 404, "ASSET_NOT_FOUND");
}
