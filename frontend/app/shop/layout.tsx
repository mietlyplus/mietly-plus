import type { Metadata } from "next";
import type { ReactNode } from "react";
import { absoluteUrl } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Alle Produkte mieten",
  description: "Das gesamte Leihfluss-Sortiment: Produkte wochen-, monats- oder tageweise mieten statt kaufen.",
  alternates: { canonical: absoluteUrl("/shop") },
};

export default function ShopLayout({ children }: { children: ReactNode }) {
  return children;
}
