import type { Metadata } from "next";
import { Showcase } from "@/components/showcase";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Салон красоты — мастера, цены, запись онлайн", description: "Мастера, цены, отзывы и онлайн-запись в салон" };
}

/** SHOWCASE-01: the salon's public page. Booking itself stays at /b/:tenant/:branch. */
export default async function ShowcasePage({ params }: { params: Promise<{ tenant: string; branch: string }> }) {
  const { tenant, branch } = await params;
  return <Showcase tenantSlug={tenant} branchSlug={branch} />;
}
