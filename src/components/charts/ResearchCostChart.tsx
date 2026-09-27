"use client";

import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
} from "recharts";

interface CostSlice {
  tier: string;
  cost: number;
  calls: number;
}

interface ResearchCostChartProps {
  data: CostSlice[];
}

const TIER_COLORS: Record<string, string> = {
  cheap: "#d1d5db",
  mid: "#6b7280",
  premium: "#111827",
};

const TIER_LABELS: Record<string, string> = {
  cheap: "Cheap (reader)",
  mid: "Mid (reasoner)",
  premium: "Premium (researcher)",
};

export function ResearchCostChart({ data }: ResearchCostChartProps) {
  if (!data || data.length === 0 || data.every((d) => d.cost === 0)) return <p className="py-8 text-sm text-[#626b78]">No research costs yet.</p>;

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
            stroke="#fff"
          >
            {data.map((entry, i) => (
              <Cell
                key={i}
                fill={TIER_COLORS[entry.tier] ?? "#d1d5db"}
                fillOpacity={0.85}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              fontSize: 12,
              fontFamily: "inherit",
              borderRadius: 8,
              border: "1px solid #e5e7eb",
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
              <span className="text-xs text-gray-600">
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
          <div className="text-xs text-gray-400 uppercase tracking-wider">
            Total
          </div>
        </div>
      </div>
    </div>
  );
}
