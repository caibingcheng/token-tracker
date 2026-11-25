#!/usr/bin/env bash
# 内存映射来源统计：把 /proc/<pid>/maps 里所有带路径的映射按文件聚合 RSS，
# 输出 top 20。用来区分「node 二进制代码页」和「应用 JS chunk」。
# 用法：bash bench/maps.sh <pid> [label]
set -uo pipefail
PID="${1:?usage: maps.sh <pid> [label]}"
LABEL="${2:-pid}"
python3 - "$PID" "$LABEL" <<'PY'
import sys, os, collections
pid, label = sys.argv[1], sys.argv[2]
maps = []
with open(f"/proc/{pid}/maps") as f:
    for line in f:
        parts = line.split()
        if len(parts) < 6:
            continue
        rng, perms, off, dev, inode, *path = parts
        p = " ".join(path) if path else ""
        if not p or p.startswith("["):
            p = p or "[anon]"
        start, end = rng.split("-")
        maps.append((int(start, 16), int(end, 16), p))

# 用 smaps 的 Rss 精确归因
agg = collections.Counter()
cur = None
with open(f"/proc/{pid}/smaps") as f:
    start = None
    for line in f:
        if "-" in line.split(" ")[0] and line[0].isdigit():
            start = int(line.split("-")[0], 16)
            name = line.strip().split(None, 5)
            cur = name[5] if len(name) > 5 else "[anon]"
        elif line.startswith("Rss:") and start is not None:
            kb = int(line.split()[1])
            agg[cur] += kb
            start = None

def bucket(p):
    if p.startswith("[anon]"):
        return "[anon]"
    if "/node" in p and p.endswith("/node"):
        return "node binary"
    if "node_modules" in p:
        return "node_modules (mmap)"
    if p.endswith(".node"):
        return "native addon"
    if "/.next/" in p:
        return ".next chunks"
    if p.endswith(".so") or ".so." in p:
        return os.path.basename(p)[:40]
    return p

b = collections.Counter()
for p, kb in agg.items():
    b[bucket(p)] += kb

total = sum(b.values())
print(f"== {label} pid={pid} total_mapped_rss={total/1024:.1f}MB")
for name, kb in b.most_common(20):
    print(f"{kb/1024:9.1f}MB  {name}")
PY
