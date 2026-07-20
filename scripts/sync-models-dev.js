const https = require("https");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "public", "data", "models-dev");
const FILES = [
  {
    url: "https://models.dev/models.json",
    file: "models.json",
  },
  {
    url: "https://models.dev/api.json",
    file: "api.json",
  },
];

function computeLatestModelUpdatedAt(apiPath) {
  try {
    const raw = fs.readFileSync(apiPath, "utf8");
    const data = JSON.parse(raw);
    let latest = null;
    for (const provider of Object.values(data)) {
      const models = provider.models || {};
      for (const model of Object.values(models)) {
        const updated = model.last_updated;
        if (!updated || updated < "2000-01-01") continue;
        if (!latest || updated > latest) {
          latest = updated;
        }
      }
    }
    return latest;
  } catch {
    return null;
  }
}

function writeMeta(apiPath) {
  const latest = computeLatestModelUpdatedAt(apiPath);
  const metaPath = path.join(DATA_DIR, "meta.json");
  const meta = { latestModelUpdatedAt: latest };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          file.on("close", resolve);
        });
      })
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const { url, file } of FILES) {
    const dest = path.join(DATA_DIR, file);
    const backup = `${dest}.bak`;
    try {
      if (fs.existsSync(dest)) {
        fs.copyFileSync(dest, backup);
      }
      await download(url, dest);
      fs.rmSync(backup, { force: true });
    } catch {
      if (fs.existsSync(backup)) {
        fs.renameSync(backup, dest);
      }
    }
  }

  writeMeta(path.join(DATA_DIR, "api.json"));
}

main();
