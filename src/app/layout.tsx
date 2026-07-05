import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Research OS",
  description: "Private investment research operating system",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f7f7f7] text-[#111111] antialiased selection:bg-[#111111] selection:text-[#ffffff]">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
