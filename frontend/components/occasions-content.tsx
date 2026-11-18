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
    title: "Occasions & kids' parties",
    intro: "Rent party equipment for 1 to 7 days. Every duration has a fixed price, shown on the product.",
    empty: "No occasion offers are available right now. Please check back soon.",
    shop: "Browse the full range",
  },
  de: {
    title: "Anlässe & Kinderfeiern",
    intro: "Partyzubehör für 1 bis 7 Tage mieten. Jede Dauer hat einen festen Preis, der beim Produkt steht.",
    empty: "Aktuell gibt es keine Angebote für Anlässe. Schau bald wieder vorbei.",
    shop: "Zum gesamten Sortiment",
  },
};

export function OccasionsContent({ products }: { products: Product[] }) {
  const { locale } = useSiteLocale("de");
  const { isWishlisted, toggleWishlist } = useWishlist();
  const text = copy[locale];
  return (
    <div className="min-h-screen bg-white">
      <ClientNavbar />
      <main className="mx-auto w-full max-w-[1280px] px-4 pb-24 pt-8 lg:pb-16">
        <h1 className="text-3xl font-extrabold text-zinc-900">{text.title}</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-600">
          {text.intro}{" "}
          <Link href="/shop" className="font-semibold text-[rgb(47,118,135)] underline">{text.shop}</Link>
        </p>
        {products.length === 0 ? (
          <p className="mt-8 text-zinc-600">{text.empty}</p>
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
