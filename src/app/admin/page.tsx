import AdminPanel from "@/components/admin/AdminPanel";
import ApiKeyGate from "@/components/ApiKeyGate";

export default function AdminPage() {
  return (
    <ApiKeyGate>
      <AdminPanel />
    </ApiKeyGate>
  );
}
