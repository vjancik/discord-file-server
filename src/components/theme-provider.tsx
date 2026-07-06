"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

// Dark-first (PRD §9): dark by default, manual toggle, no system detection.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
    >
      {children}
    </NextThemesProvider>
  );
}
