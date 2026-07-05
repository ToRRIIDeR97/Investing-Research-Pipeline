"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";

interface MetricPoint {
  period: string;
  value: number;
  metric_name: string;
}

interface MetricHistoryChartProps {
  data: MetricPoint[];
  unit?: string;
  currency?: string;
}

export function MetricHistoryChart({
  data,
  unit,
  currency,
}: MetricHistoryChartProps) {
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
              d="M3 3v18h18M7 16l4-4 4 4 5-5"
            />
          </svg>
          <p className="text-[11px] text-gray-400 font-medium">
            No metric observations yet
          </p>
          <p className="text-[10px] text-gray-300 mt-0.5">
            Run research to generate data
          </p>
        </div>
      </div>
    );
  }

  // Group by metric name for multi-series support
  const metricNames = [...new Set(data.map((d) => d.metric_name))];
  const periods = [...new Set(data.map((d) => d.period))].sort();

  // Build chart data: one row per period, with each metric as a key
  const chartData = periods.map((period) => {
    const row: Record<string, string | number> = { period };
    for (const name of metricNames) {
      const point = data.find(
        (d) => d.period === period && d.metric_name === name
      );
      row[name] = point?.value ?? 0;
    }
    return row;
  });

  // Monochrome palette for multiple series
  const colors = ["#111827", "#6b7280", "#9ca3af", "#d1d5db"];

  return (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={chartData}
          margin={{ top: 4, right: 4, left: -12, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
          <XAxis
            dataKey="period"
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) =>
              currency ? `${currency}${(v / 1000).toFixed(0)}k` : v.toLocaleString()
            }
          />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              fontFamily: "inherit",
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            }}
            formatter={(value: number, name: string) => [
              unit ? `${value.toLocaleString()} ${unit}` : value.toLocaleString(),
              name,
            ]}
            labelStyle={{ color: "#6b7280", fontSize: 10 }}
          />
          {metricNames.map((name, i) => (
            <Area
              key={name}
              type="monotone"
              dataKey={name}
              stroke={colors[i % colors.length]}
              fill={colors[i % colors.length]}
              fillOpacity={0.06}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
