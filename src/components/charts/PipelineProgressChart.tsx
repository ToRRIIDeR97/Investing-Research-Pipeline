"use client";

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from "recharts";

interface StageInfo {
  stage_key: string;
  status: string;
  stage_order: number;
}

interface PipelineProgressChartProps {
  data: StageInfo[];
}

const STATUS_COLORS: Record<string, string> = {
  completed: "#469172",
  running: "#7a91a6",
  pending: "#e5e7eb",
  failed: "#bf5549",
  skipped: "#f3f4f6",
  waiting_for_human: "#b7893e",
};

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  running: "Running",
  pending: "Pending",
  failed: "Failed",
  skipped: "Skipped",
  waiting_for_human: "Awaiting Review",
};

const STAGE_LABELS: Record<string, string> = {
  intake: "Intake",
  asset_identity: "Identity",
  research_plan: "Plan",
  source_discovery: "Sources",
  source_ingestion: "Ingest",
  evidence_extraction: "Evidence",
  metric_normalization: "Metrics",
  asset_analysis: "Analysis",
  asset_valuation: "Valuation",
  thesis_risks: "Thesis",
  indicator_design: "Indicators",
  strategy_design: "Strategies",
  backtest_execution: "Backtest",
  backtest_review: "BT Review",
  ai_reviewer: "AI Review",
  human_review: "Human Review",
  export: "Export",
  refresh_schedule: "Refresh",
};

export function PipelineProgressChart({ data }: PipelineProgressChartProps) {
  if (!data || data.length === 0) return <p className="py-8 text-sm text-[#626b78]">No pipeline data yet.</p>;

  // Sort by stage_order and build chart data
  const sorted = [...data].sort((a, b) => a.stage_order - b.stage_order);
  const chartData = sorted.map((s) => ({
    name: STAGE_LABELS[s.stage_key] ?? s.stage_key.replace(/_/g, " "),
    fullName: s.stage_key,
    value: 1,
    status: s.status,
    order: s.stage_order,
  }));

  const completedCount = data.filter((d) => d.status === "completed").length;
  const totalRelevant = data.filter((d) => d.status !== "skipped").length;

  return (
    <div className="flex flex-col" style={{ height: Math.max(220, data.length * 28 + 40) }}>
      {/* Summary line */}
      <div className="flex items-center justify-between px-1 mb-2">
        <span className="text-xs text-gray-400 font-medium">
          {completedCount}/{totalRelevant} stages complete
        </span>
        <div className="flex gap-2">
          {["completed", "running", "pending", "failed"].map((status) => {
            const count = data.filter((d) => d.status === status).length;
            if (count === 0) return null;
            return (
              <span
                key={status}
                className="flex items-center gap-1 text-xs text-gray-500"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: STATUS_COLORS[status] }}
                />
                {count}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 0, right: 4, left: 4, bottom: 0 }}
            barCategoryGap={2}
          >
            <XAxis type="number" domain={[0, 1]} hide />
            <YAxis
              type="category"
              dataKey="name"
              width={150}
              tick={{ fontSize: 12, fill: "#626b78" }}
              tickLine={false}
              interval={0}
              axisLine={false}
            />
            <Tooltip
              cursor={false}
              contentStyle={{
                fontSize: 12,
                fontFamily: "inherit",
                borderRadius: 8,
                border: "1px solid #e5e7eb",
                boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
              }}
              formatter={(_value: number, _name: string, item: any) => {
                const d = item?.payload;
                if (!d) return ["", ""];
                return [
                  <span key="t" className="font-medium">
                    {STATUS_LABELS[d.status] ?? d.status}
                  </span>,
                  d.fullName ?? "",
                ];
              }}
            />
            <Bar dataKey="value" radius={[3, 3, 3, 3]} barSize={14}>
              {chartData.map((entry, i) => (
                <Cell
                  key={i}
                  fill={STATUS_COLORS[entry.status] ?? "#e5e7eb"}
                  fillOpacity={entry.status === "pending" ? 0.4 : 0.85}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
