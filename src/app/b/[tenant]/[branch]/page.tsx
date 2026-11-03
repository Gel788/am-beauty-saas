import type { Metadata } from "next";
import { BookingWidget } from "@/components/booking-widget";

export const metadata: Metadata = { title: "Онлайн-запись", description: "Запись в салон онлайн" };

export default async function BookingPage({ params }: { params: Promise<{ tenant: string; branch: string }> }) {
  const { tenant, branch } = await params;
  return <BookingWidget tenantSlug={tenant} branchSlug={branch} />;
}
