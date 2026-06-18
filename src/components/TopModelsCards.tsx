"use client";

import { formatNumber } from "@/lib/number-utils";
import { useNumberFormat } from "./NumberFormatContext";

interface TopModel {
  displayName: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
}

interface TopModelsCardsProps {
  title: string;
  models: TopModel[];
  loading?: boolean;
}

function formatRatio(num: number): string {
  return `${num.toFixed(1)}%`;
}

export default function TopModelsCards({ title, models, loading }: TopModelsCardsProps) {
  const { compact } = useNumberFormat();
  if (loading) {
    return (
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">{title}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="bg-gray-50 rounded-lg p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
              <div className="space-y-2">
                <div className="h-3 bg-gray-200 rounded"></div>
                <div className="h-3 bg-gray-200 rounded"></div>
                <div className="h-3 bg-gray-200 rounded"></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!models || models.length === 0) {
    return (
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">{title}</h3>
        <p className="text-sm text-gray-400">No model data</p>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {models.map((model, index) => {
          const hitRate =
            model.totalInput > 0
              ? (model.totalInputCached / model.totalInput) * 100
              : 0;

          return (
            <div
              key={`${model.displayName}-${index}`}
              className="bg-gray-50 rounded-lg p-4 flex flex-col justify-between"
            >
              <p
                className="text-sm font-medium text-gray-900 truncate"
                title={model.displayName}
              >
                {model.displayName}
              </p>
              <div className="mt-3 space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-gray-400">Input</span>
                  <span
                    className="font-semibold text-gray-700 whitespace-nowrap"
                    title={formatNumber(model.totalInput, false)}
                  >
                    {formatNumber(model.totalInput, compact)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-gray-400">Output</span>
                  <span
                    className="font-semibold text-gray-700 whitespace-nowrap"
                    title={formatNumber(model.totalOutput, false)}
                  >
                    {formatNumber(model.totalOutput, compact)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-gray-400">Hit</span>
                  <span className="font-semibold text-gray-700 whitespace-nowrap">
                    {formatRatio(hitRate)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
