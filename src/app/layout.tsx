import type { Metadata, Viewport } from "next";
import { Fraunces, Inter, Unbounded } from "next/font/google";
import { ToastProvider } from "@/components/ui";
import { ServiceWorker } from "@/components/pwa";
import "./globals.css";

const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-inter" });
const unbounded = Unbounded({ subsets: ["latin", "cyrillic"], variable: "--font-unbounded" });
const fraunces = Fraunces({ subsets: ["latin"], style: ["italic", "normal"], variable: "--font-fraunces" });

export const metadata: Metadata = {
  title: "Am Beauty",
  description: "Журнал и клиенты салона красоты",
  applicationName: "Am Beauty",
  appleWebApp: { capable: true, title: "Am Beauty", statusBarStyle: "default" },
  icons: { icon: "/icons/icon.svg", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = { themeColor: "#7c5cff", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className={`${inter.variable} ${unbounded.variable} ${fraunces.variable}`}>
        <ToastProvider>{children}</ToastProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
