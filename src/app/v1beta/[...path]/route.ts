import { NextRequest } from "next/server";
import { handleProxyRequest } from "@/lib/gateway/proxy";
import { createProxyDeps } from "@/lib/gateway/proxy-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleProxyRequest(request, createProxyDeps());
}

export async function POST(request: NextRequest) {
  return handleProxyRequest(request, createProxyDeps());
}

export async function PUT(request: NextRequest) {
  return handleProxyRequest(request, createProxyDeps());
}

export async function PATCH(request: NextRequest) {
  return handleProxyRequest(request, createProxyDeps());
}
