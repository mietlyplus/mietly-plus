"use client";

import Link from "next/link";
import { ClientNavbar } from "@/components/client-navbar";
import { HomeFooter } from "@/components/home-footer";
import { RentalProductCard } from "@/components/rental-product-card";
import { useSiteLocale } from "@/lib/use-site-locale";
import { useWishlist } from "@/lib/use-wishlist";
import type { Product } from "@/lib/types";

const copy = {
  en: {
    home: "Home",
    heading: (name: string) => `Rent ${name}`,
    intro: (name: string) => `Rent ${name} flexibly instead of buying. All offers include delivery in Germany.`,
    shop: "Browse the full range",
    empty: "There are no offers in this category right now.",
  },
  de: {
    home: "Start",
    heading: (name: string) => `${name} mieten`,
    intro: (name: string) => `${name} flexibel mieten statt kaufen. Alle Angebote mit Lieferung in Deutschland.`,
    shop: "Zum gesamten Sortiment",
    empty: "In dieser Kategorie gibt es gerade keine Angebote.",
  },
};

export function CategoryLandingContent({
  name,
  nameEn,
  products,
}: {
  name: string;
  nameEn: string;
  products: Product[];
}) {
  const { locale } = useSiteLocale("de");
  const { isWishlisted, toggleWishlist } = useWishlist();
  const t = copy[locale];
  const shown = locale === "en" ? nameEn || name : name;
  return (
    <div className="min-h-screen bg-white">
      <ClientNavbar />
      <main className="mx-auto w-full max-w-[1280px] px-4 pb-24 pt-8 lg:pb-16">
        <nav aria-label="Breadcrumb" className="text-sm text-zinc-500">
          <Link href="/" className="hover:underline">{t.home}</Link> / <span className="text-zinc-800">{shown}</span>
        </nav>
        <h1 className="mt-3 text-3xl font-extrabold text-zinc-900">{t.heading(shown)}</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-600">
          {t.intro(shown)}{" "}
          <Link href="/shop" className="font-semibold text-[rgb(47,118,135)] underline">{t.shop}</Link>
        </p>
        {products.length === 0 ? (
          <p className="mt-8 text-zinc-600">{t.empty}</p>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5 lg:grid-cols-4">
            {products.map((product) => (
              <RentalProductCard
                key={product.id}
                product={product}
                wishlistActive={isWishlisted(product.id)}
                onToggleWishlist={(id: string) => void toggleWishlist(id)}
              />
            ))}
          </div>
        )}
      </main>
      <HomeFooter />
    </div>
  );
}
