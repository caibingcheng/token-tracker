"use client";

import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface ProviderData {
  group: string;
  totalInput: number;
}

export default function ProviderDistributionChart() {
  const [data, setData] = useState<ProviderData[]>([]);

  useEffect(() => {
    const apiKey = localStorage.getItem("token-tracker-api-key") || "";
    if (!apiKey) return;

    fetch("/api/stats?groupBy=provider", {
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
      <h3 className="text-lg font-semibold mb-4">By Provider</h3>
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="group" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="totalInput" fill="#3B82F6" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
