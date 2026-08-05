import Dashboard from "@/components/Dashboard";
import ApiKeyGate from "@/components/ApiKeyGate";

export default function Home() {
  return (
    <ApiKeyGate>
      <Dashboard />
    </ApiKeyGate>
  );
}
