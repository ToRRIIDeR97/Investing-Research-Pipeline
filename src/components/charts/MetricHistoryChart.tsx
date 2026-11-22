"use client";

import { useState } from "react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { C } from "@/components/ui/palette";

interface MetricPoint { period: string; value: number; metric_name: string; }
interface MetricHistoryChartProps { data: MetricPoint[]; unit?: string; currency?: string; }

export function MetricHistoryChart({ data, unit, currency }: MetricHistoryChartProps) {
  const [selectedMetric, setSelectedMetric] = useState("");
  if (!data?.length) return <p className="py-8 text-sm text-[var(--ink-3)]">No metric observations yet.</p>;
  const names = [...new Set(data.map((point) => point.metric_name))];
  const activeMetric = names.includes(selectedMetric) ? selectedMetric : names[0];
  const points = data.filter((point) => point.metric_name === activeMetric).sort((a, b) => a.period.localeCompare(b.period));
  return <div>
    <select aria-label="Metric" value={activeMetric} onChange={(event) => setSelectedMetric(event.target.value)} className="mb-4 min-h-11 w-full rounded-[5px] border border-[var(--line-strong)] bg-transparent px-3 text-sm">
      {names.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={C.line} />
          <XAxis dataKey="period" tick={{ fontSize: 12, fill: C.ink3 }} tickFormatter={(value) => String(value).slice(0, 10)} minTickGap={32} tickLine={false} axisLine={false} />
          <YAxis width={64} tick={{ fontSize: 12, fill: C.ink3 }} tickFormatter={(value) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={{ fontSize: 13, border: `1px solid ${C.line}`, borderRadius: 5 }} formatter={(value: number) => [`${Number(value).toLocaleString()}${currency || unit ? ` ${currency || unit}` : ""}`, activeMetric]} />
          <Area type="linear" dataKey="value" stroke={C.ink3} fill={C.lineSoft} strokeWidth={1.5} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  </div>;
}
