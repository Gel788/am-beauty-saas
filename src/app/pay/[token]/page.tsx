import type { Metadata } from "next";
import { PayPage } from "@/components/pay-page";

export const metadata: Metadata = { title: "Оплата визита", description: "Оплата картой или по СБП", robots: { index: false } };

export default async function PayTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PayPage token={token} />;
}
