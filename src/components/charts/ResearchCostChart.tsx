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
  if (!data || data.length === 0 || data.every((d) => d.cost === 0)) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-xl border border-gray-100 bg-[#fbfcfd]">
        <div className="text-center">
          <svg
            className="w-6 h-6 mx-auto mb-2 text-gray-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-[11px] text-gray-400 font-medium">
            No cost data yet
          </p>
          <p className="text-[10px] text-gray-300 mt-0.5">
            Model spend appears after research runs
          </p>
        </div>
      </div>
    );
  }

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
              fontSize: 11,
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
              <span className="text-[10px] text-gray-600">
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
          <div className="text-[9px] text-gray-400 uppercase tracking-wider">
            Total
          </div>
        </div>
      </div>
    </div>
  );
}
