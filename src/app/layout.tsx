import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SideNav } from "@/components/SideNav";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "머무룸 AX",
  description: "머무룸 예약 및 운영 관리",
  applicationName: "머무룸 AX",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    title: "머무룸 AX",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#f8fafc",
  colorScheme: "light",
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
      className={`${geistSans.variable} ${geistMono.variable} h-full bg-slate-50 antialiased`}
    >
      <body className="min-h-full flex bg-slate-50 text-slate-900">
        <ServiceWorkerRegistration />
        <SideNav />
        <main data-app-main className="flex-1 w-full md:ml-64 h-screen overflow-y-auto pb-20 md:pb-0">
          {children}
        </main>
      </body>
    </html>
  );
}
