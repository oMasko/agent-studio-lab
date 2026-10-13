import type { Metadata } from "next";

import "./globals.css";


export const metadata: Metadata = {
  title: "Agent Studio",
  description: "A generic multi-agent chat built with the OpenAI Agents SDK",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
