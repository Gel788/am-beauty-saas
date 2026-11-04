import type { Metadata } from "next";
import { PrivacyPage } from "@/components/privacy-page";

export const metadata: Metadata = { title: "Политика обработки персональных данных" };

export default async function Privacy({ params }: { params: Promise<{ tenant: string; branch: string }> }) {
  const { tenant, branch } = await params;
  return <PrivacyPage tenantSlug={tenant} branchSlug={branch} />;
}
