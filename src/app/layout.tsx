import type { Metadata } from "next";
import { Inter, Playfair_Display, Unbounded } from "next/font/google";
import { ToastProvider } from "@/components/ui";
import "./globals.css";

const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-inter" });
const unbounded = Unbounded({ subsets: ["latin", "cyrillic"], variable: "--font-unbounded" });
const playfair = Playfair_Display({ subsets: ["latin", "cyrillic"], style: ["italic", "normal"], variable: "--font-playfair" });

export const metadata: Metadata = {
  title: "Am Beauty",
  description: "Журнал и клиенты салона красоты",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className={`${inter.variable} ${unbounded.variable} ${playfair.variable}`}>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
