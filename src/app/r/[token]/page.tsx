import type { Metadata } from "next";
import { ReviewPage } from "@/components/review-page";

export const metadata: Metadata = { title: "Оцените визит", description: "Отзыв о визите в салон", robots: { index: false } };

export default async function ReviewTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ReviewPage token={token} />;
}
