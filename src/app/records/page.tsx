import { Suspense } from "react";
import RecordsPage from "@/components/RecordsPage";

export default function Records() {
  // useSearchParams 需要 Suspense 边界，否则整页被强制 CSR bailout
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-gray-50 p-4 md:p-8">
          <div className="max-w-7xl mx-auto h-4 animate-pulse rounded bg-gray-200" />
        </main>
      }
    >
      <RecordsPage />
    </Suspense>
  );
}
