"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface TrendData {
  group: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
}

export default function TrendChart({ range = "30d" }: { range?: string }) {
  const [data, setData] = useState<TrendData[]>([]);

  useEffect(() => {
    const apiKey = localStorage.getItem("token-tracker-api-key") || "";
    if (!apiKey) return;

    fetch(`/api/stats?groupBy=date&range=${range}`, {
      headers: { "X-API-Key": apiKey },
    })
      .then((res) => res.json())
      .then((result) => {
        if (result.success) {
          setData(result.data);
        }
      });
  }, [range]);

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-8">
      <h3 className="text-lg font-semibold mb-4">Token Usage Trend</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="group" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="totalInput" stroke="#3B82F6" name="Input" />
          <Line type="monotone" dataKey="totalOutput" stroke="#10B981" name="Output" />
          <Line type="monotone" dataKey="totalCacheRead" stroke="#8B5CF6" name="Cache Read" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
