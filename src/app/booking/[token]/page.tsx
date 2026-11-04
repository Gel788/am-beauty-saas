import type { Metadata } from "next";
import { BookingManage } from "@/components/booking-manage";

export const metadata: Metadata = { title: "Ваша запись", description: "Управление онлайн-записью", robots: { index: false } };

export default async function ManageBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <BookingManage token={token} />;
}
