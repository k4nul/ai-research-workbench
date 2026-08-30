import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AI Research Workbench",
    template: "%s · AI Research Workbench",
  },
  description:
    "An evidence-first workspace for planning, verifying, and delivering research.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
