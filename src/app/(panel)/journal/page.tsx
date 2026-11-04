import { Suspense } from "react";
import { JournalBoard } from "@/components/journal-board";

export default function JournalPage() {
  return (
    <Suspense fallback={<div className="skeleton" />}>
      <JournalBoard />
    </Suspense>
  );
}
