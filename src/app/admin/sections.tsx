import type { ComponentType } from "react";

// Admin 分区元数据：移动端列表页（/admin）与子页头部共用。
// 桌面端导航在 AppSidebar（/admin 下展开子项），这里只描述分区本身。

function IconUpstreams() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" aria-hidden="true" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}
function IconModels() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" aria-hidden="true" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}
function IconVirtualKeys() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" aria-hidden="true" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}
function IconSecurity() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" aria-hidden="true" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
function IconDisplay() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" aria-hidden="true" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}
function IconSync() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" aria-hidden="true" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
function IconDevices() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" aria-hidden="true" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="12" rx="2" />
      <line x1="8" y1="20" x2="16" y2="20" />
      <line x1="12" y1="16" x2="12" y2="20" />
    </svg>
  );
}

function IconAudit() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" aria-hidden="true" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  );
}

export interface AdminSection {
  id: string;
  label: string;
  description: string;
  Icon: ComponentType;
}

export const ADMIN_SECTIONS: AdminSection[] = [
  { id: "upstreams", label: "Upstreams", description: "Channels, keys, probes, balance", Icon: IconUpstreams },
  { id: "models", label: "Models", description: "Prices, models.dev, named routes", Icon: IconModels },
  { id: "virtual-keys", label: "Virtual Keys", description: "Client keys, quotas, rate limits", Icon: IconVirtualKeys },
  { id: "security", label: "Security", description: "Admin key, TOTP, session policy", Icon: IconSecurity },
  { id: "display", label: "Display", description: "Aliases, provider anonymization", Icon: IconDisplay },
  { id: "sync", label: "Sync", description: "Multi-instance push and ingest", Icon: IconSync },
  { id: "devices", label: "Devices", description: "Relay sub nodes, pairing, tokens", Icon: IconDevices },
  { id: "audit", label: "Audit", description: "Admin operation log", Icon: IconAudit },
];

export function findAdminSection(pathname: string | null): AdminSection | undefined {
  return ADMIN_SECTIONS.find((section) => pathname === `/admin/${section.id}`);
}
