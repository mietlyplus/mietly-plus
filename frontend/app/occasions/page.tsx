import type { Metadata } from "next";
import { OccasionsContent } from "@/components/occasions-content";
import { SITE_NAME, absoluteUrl, getProductsForSeo } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Anlässe & Kinderfeiern mieten",
  description:
    "Hüpfburgen, Deko und Partyzubehör tageweise mieten, von 1 bis 7 Tagen, zum festen Preis. Lieferung in Deutschland.",
  alternates: { canonical: absoluteUrl("/occasions") },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "de_DE",
    url: absoluteUrl("/occasions"),
    title: "Anlässe & Kinderfeiern mieten | Leihfluss",
    description: "Partyzubehör tageweise mieten, 1 bis 7 Tage, fester Preis pro Dauer.",
  },
};

// Always current: a new or edited occasion product must show up without a rebuild.
export const dynamic = "force-dynamic";

export default async function OccasionsPage() {
  // Rendered on the server so the products are in the page HTML for search engines.
  const products = (await getProductsForSeo()).filter((product) => product.rentalMode === "occasion");
  return <OccasionsContent products={products} />;
}
