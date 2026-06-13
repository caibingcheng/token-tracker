import Dashboard from "@/components/Dashboard";
import PriceUpdateTime from "@/components/PriceUpdateTime";

export default function Home() {
  return <Dashboard priceUpdateTime={<PriceUpdateTime />} />;
}
