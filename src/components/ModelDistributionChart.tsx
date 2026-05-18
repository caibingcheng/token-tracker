"use client";

import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";

const COLORS = ["#3B82F6", "#10B981", "#8B5CF6", "#F59E0B", "#EF4444", "#EC4899"];

interface ModelData {
  group: string;
  totalInput: number;
}

export default function ModelDistributionChart() {
  const [data, setData] = useState<ModelData[]>([]);

  useEffect(() => {
    const apiKey = localStorage.getItem("token-tracker-api-key") || "";
    if (!apiKey) return;

    fetch("/api/stats?groupBy=model", {
      headers: { "X-API-Key": apiKey },
    })
      .then((res) => res.json())
      .then((result) => {
        if (result.success) {
          setData(result.data);
        }
      });
  }, []);

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-4">By Model</h3>
      <ResponsiveContainer width="100%" height={250}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            labelLine={false}
            label={(entry) => `${entry.group}: ${entry.totalInput}`}
            outerRadius={80}
            fill="#8884d8"
            dataKey="totalInput"
          >
            {data.map((_, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
