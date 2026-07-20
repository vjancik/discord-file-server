import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { deriveBaseUrl } from "@/lib/env";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Lenient env read: getEnv() would throw during `next build`, where runtime
// env is absent (see src/lib/env.ts). Missing base URL only affects
// build-prerendered pages, which fall back to Next's localhost default.
const { DOMAIN, BASE_URL } = process.env;
const baseUrl =
  DOMAIN || BASE_URL ? deriveBaseUrl(DOMAIN ?? "", BASE_URL) : undefined;

export const metadata: Metadata = {
  metadataBase: baseUrl ? new URL(baseUrl) : undefined,
  title: "Discord File Server",
  description:
    "Share files with your Discord community without the upload limits.",
  openGraph: {
    // Deliberately absolute (not the opengraph-image file convention, not a
    // relative path): Next hard-codes localhost as the social-image base
    // when NODE_ENV=development (getSocialImageMetadataBaseFallback), so
    // anything base-resolved embeds as an unfetchable localhost URL from a
    // dev-mode deployment. An absolute URL skips that resolution entirely.
    images: [
      {
        url: `${baseUrl ?? ""}/og.png`,
        width: 1024,
        height: 1024,
        alt: "Discord File Server logo",
      },
    ],
  },
  // "summary" renders the compact right-aligned thumbnail on Discord/Twitter
  // cards instead of the full-width image.
  twitter: { card: "summary" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          {children}
          <Toaster richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
