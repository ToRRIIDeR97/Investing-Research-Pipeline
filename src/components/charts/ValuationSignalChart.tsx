"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";

interface ValuationSignal {
  signal_name: string;
  signal: string;
  cheapness_score: number | null;
  current_value: number | null;
  lens_family: string;
}

interface ValuationSignalChartProps {
  data: ValuationSignal[];
}

const SIGNAL_COLORS: Record<string, string> = {
  very_cheap: "#065f46",
  cheap: "#469172",
  neutral: "#6b7280",
  expensive: "#bf5549",
  very_expensive: "#991b1b",
  inconclusive: "#d1d5db",
  not_applicable: "#e5e7eb",
};

const SIGNAL_LABELS: Record<string, string> = {
  very_cheap: "Very Cheap",
  cheap: "Cheap",
  neutral: "Neutral",
  expensive: "Expensive",
  very_expensive: "Very Expensive",
  inconclusive: "Inconclusive",
  not_applicable: "N/A",
};

export function ValuationSignalChart({ data }: ValuationSignalChartProps) {
  if (!data || data.length === 0) return <p className="py-8 text-sm text-[#626b78]">No valuation signals yet.</p>;

  // Sort by cheapness_score descending (cheapest first)
  const chartData = data
    .filter((d) => d.signal !== "not_applicable")
    .map((d) => ({
      name:
        d.signal_name.length > 20
          ? d.signal_name.slice(0, 18) + "…"
          : d.signal_name,
      fullName: d.signal_name,
      score: d.cheapness_score ?? 0,
      signal: d.signal,
      value: d.current_value,
      lens: d.lens_family,
    }))
    .sort((a, b) => b.score - a.score);

  if (chartData.length === 0) return <p className="py-8 text-sm text-[#626b78]">No applicable valuation signals.</p>;

  const barHeight = Math.max(28, Math.min(40, 220 / chartData.length));

  return (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 4, right: 12, left: 4, bottom: 0 }}
          barCategoryGap={4}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#f3f4f6"
            horizontal={false}
          />
          <XAxis
            type="number"
            domain={[0, 100]}
            tick={{ fontSize: 12, fill: "#626b78" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
            tickFormatter={(v) => `${v}`}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={100}
            tick={{ fontSize: 12, fill: "#6b7280" }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(0,0,0,0.02)" }}
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
                <div key="tooltip" className="space-y-0.5">
                  <div className="font-semibold">{d.fullName}</div>
                  <div className="text-gray-500">
                    {SIGNAL_LABELS[d.signal] ?? d.signal} · Score: {d.score}
                  </div>
                  {d.value != null && (
                    <div className="text-gray-500">
                      Value: {d.value.toLocaleString()}
                    </div>
                  )}
                  <div className="text-gray-400 text-xs">{d.lens}</div>
                </div>,
                "",
              ];
            }}
          />
          <Bar dataKey="score" radius={[0, 4, 4, 0]} barSize={barHeight}>
            {chartData.map((entry, i) => (
              <Cell
                key={i}
                fill={SIGNAL_COLORS[entry.signal] ?? "#d1d5db"}
                fillOpacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
