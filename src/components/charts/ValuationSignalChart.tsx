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
  cheap: "#059669",
  neutral: "#6b7280",
  expensive: "#dc2626",
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
  if (!data || data.length === 0) {
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
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2z"
            />
          </svg>
          <p className="text-[11px] text-gray-400 font-medium">
            No valuation signals yet
          </p>
          <p className="text-[10px] text-gray-300 mt-0.5">
            Complete a research run to generate signals
          </p>
        </div>
      </div>
    );
  }

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

  if (chartData.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-xl border border-gray-100 bg-[#fbfcfd]">
        <p className="text-[11px] text-gray-400 font-medium">
          All signals marked N/A
        </p>
      </div>
    );
  }

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
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
            tickFormatter={(v) => `${v}`}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={100}
            tick={{ fontSize: 10, fill: "#6b7280" }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(0,0,0,0.02)" }}
            contentStyle={{
              fontSize: 11,
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
                  <div className="text-gray-400 text-[10px]">{d.lens}</div>
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
