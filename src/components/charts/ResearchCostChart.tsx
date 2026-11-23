"use client";

import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
} from "recharts";
import { C } from "@/components/ui/palette";

interface CostSlice {
  tier: string;
  cost: number;
  calls: number;
}

interface ResearchCostChartProps {
  data: CostSlice[];
}

const TIER_COLORS: Record<string, string> = {
  cheap: C.lineStrong,
  mid: C.ink3,
  premium: C.ink,
};

const TIER_LABELS: Record<string, string> = {
  cheap: "Cheap (reader)",
  mid: "Mid (reasoner)",
  premium: "Premium (researcher)",
};

export function ResearchCostChart({ data }: ResearchCostChartProps) {
  if (!data || data.length === 0 || data.every((d) => d.cost === 0)) return <p className="py-8 text-sm text-[var(--ink-3)]">No research costs yet.</p>;

  const totalCost = data.reduce((sum, d) => sum + d.cost, 0);

  return (
    <div className="h-[220px] relative">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="cost"
            nameKey="tier"
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={80}
            strokeWidth={2}
            stroke={C.tile}
          >
            {data.map((entry, i) => (
              <Cell
                key={i}
                fill={TIER_COLORS[entry.tier] ?? C.lineStrong}
                fillOpacity={0.85}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              fontSize: 12,
              fontFamily: "inherit",
              borderRadius: 8,
              border: `1px solid ${C.line}`,
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            }}
            formatter={(value: number, name: string) => [
              `$${value.toFixed(4)} (${data.find((d) => d.tier === name)?.calls ?? 0} calls)`,
              TIER_LABELS[name] ?? name,
            ]}
          />
          <Legend
            iconType="circle"
            iconSize={6}
            formatter={(value: string) => (
              <span className="text-xs text-[var(--ink-2)]">
                {TIER_LABELS[value] ?? value}
              </span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
      {/* Center label */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-center mt-2">
          <div className="text-[13px] font-bold text-black">
            ${totalCost.toFixed(2)}
          </div>
          <div className="text-xs text-[var(--ink-3)]">
            Total
          </div>
        </div>
      </div>
    </div>
  );
}
