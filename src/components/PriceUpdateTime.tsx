import fs from "fs";
import path from "path";
import { unstable_cache } from "next/cache";

const getPriceUpdateTime = unstable_cache(
  async () => {
    const filePath = path.join(
      process.cwd(),
      "public",
      "data",
      "models-dev",
      "api.json"
    );
    try {
      const stats = fs.statSync(filePath);
      return stats.mtime.toISOString().split("T")[0];
    } catch {
      return null;
    }
  },
  ["price-update-time"],
  { revalidate: 3600 }
);

export default async function PriceUpdateTime() {
  const updatedAt = await getPriceUpdateTime();

  if (!updatedAt) return null;

  return (
    <span className="text-sm text-gray-500">
      Prices updated: {updatedAt}
    </span>
  );
}
