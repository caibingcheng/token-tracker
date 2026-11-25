#!/usr/bin/env node
// 只在「镜像已换、容器的启动命令还是旧版」时被执行：镜像里把它拷成 /app/server.js。
//
// v1.6.0 起服务端入口从 /app/server.js（Next standalone）换成 build/server.js（Hono + esbuild bundle）。
// 换镜像时如果容器是按旧容器配置重建的（配置里存着 CMD `node server.js`），新镜像就被指向一条
// 已不存在的路径，Node 只吐一句 `Cannot find module '/app/server.js'` —— 看不出是启动命令过时。
// 这个文件把那条报错换成人话，行为保持不变：失败退出（非零退出码），让编排层回滚。
//
// 不要删，也不要改成能跑起来的转发（用 require 指向 build/server.js）：旧命令少了
// --optimize-for-size，转发等于把「容器配置已过时」永久藏进日志角落里。
console.error(
  [
    "[token-tracker] 启动失败：镜像里没有 /app/server.js —— v1.6.0 起服务端入口改为 build/server.js。",
    "",
    "原因：容器仍在用旧版本的启动命令（node server.js）。换镜像时若沿用旧容器配置重建，",
    "      命令不会随新镜像的 CMD 更新：各面板/编排工具的「升级镜像」、自定义过 command 的",
    "      compose / docker run、systemd unit、K8s manifest 都会这样。",
    "",
    "办法：让镜像自带的 CMD 生效 —— 删掉旧容器后重新部署（数据在 /app/data，删容器不丢，",
    "      但删之前请确认它已挂到卷或宿主机目录）。不要把命令抄一份进配置，那正是这次失效的原因；",
    "      部署工具不允许留空时，以镜像自带的那条为准：",
    "      docker image inspect <镜像> --format '{{json .Config.Cmd}}'",
    "",
    "自查旧容器：docker inspect <容器> --format '{{json .Config.Cmd}}'",
    "      输出里出现 server.js 且没有 build/ → 就是那条过时命令。",
  ].join("\n"),
);
process.exit(1);
