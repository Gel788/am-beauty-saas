import type { Metadata } from "next";
import { BookingWidget } from "@/components/booking-widget";

export async function generateMetadata({ params }: { params: Promise<{ tenant: string; branch: string }> }): Promise<Metadata> {
  const { tenant, branch } = await params;
  // PWA-INSTALL-02: the page has its own manifest, so «На экран Домой» opens straight into booking.
  return { title: "Онлайн-запись", description: "Запись в салон онлайн", manifest: `/b/${tenant}/${branch}/manifest.webmanifest` };
}

export default async function BookingPage({ params }: { params: Promise<{ tenant: string; branch: string }> }) {
  const { tenant, branch } = await params;
  return <BookingWidget tenantSlug={tenant} branchSlug={branch} />;
}
