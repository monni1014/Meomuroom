import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SideNav } from "@/components/SideNav";
import { AppBackButton } from "@/components/AppBackButton";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "머무룸 DX",
  description: "머무룸 예약 및 운영 관리",
  applicationName: "머무룸 DX",
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
};

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex bg-slate-50 text-slate-900">
        <SideNav />
        <main className="flex-1 w-full md:ml-64 h-screen overflow-y-auto">
          <AppBackButton />
          {children}
        </main>
      </body>
    </html>
  );
}
