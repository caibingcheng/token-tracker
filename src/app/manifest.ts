import type { MetadataRoute } from "next";

// output: 'export' 下元数据路由需要显式声明静态（否则 build 报 dynamic not configured）
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Token Tracker",
    short_name: "Tokens",
    description: "LLM Token Usage Dashboard",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#111827",
    background_color: "#f9fafb",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
