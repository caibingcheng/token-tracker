import fs from "fs";
import path from "path";

const META_PATH = path.join(
  process.cwd(),
  "public",
  "data",
  "models-dev",
  "meta.json"
);

export default async function PriceUpdateTime() {
  let updatedAt: string | null = null;

  try {
    const raw = fs.readFileSync(META_PATH, "utf8");
    const meta = JSON.parse(raw);
    updatedAt = meta.latestModelUpdatedAt ?? null;
  } catch {
    return null;
  }

  if (!updatedAt) return null;

  return (
    <span className="text-sm text-gray-500">
      Prices updated: {updatedAt}
    </span>
  );
}
