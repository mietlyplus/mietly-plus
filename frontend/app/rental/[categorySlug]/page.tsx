import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClientNavbar } from "@/components/client-navbar";
import { HomeFooter } from "@/components/home-footer";
import { JsonLd } from "@/components/json-ld";
import { RentalProductCard } from "@/components/rental-product-card";
import type { Category } from "@/lib/types";
import { SITE_NAME, absoluteUrl, breadcrumbJsonLd, fetchCategoryTree, getProductsForSeo } from "@/lib/seo";

type Params = { params: Promise<{ categorySlug: string }> };

function findCategory(tree: Category[], slug: string): Category | null {
  for (const category of tree) {
    if (category.slug === slug) return category;
    const child = findCategory(category.children || [], slug);
    if (child) return child;
  }
  return null;
}

function descendantSlugs(category: Category): string[] {
  return [category.slug, ...(category.children || []).flatMap(descendantSlugs)];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { categorySlug } = await params;
  const category = findCategory(await fetchCategoryTree(), categorySlug);
  if (!category) return { title: "Kategorie nicht gefunden", robots: { index: false, follow: false } };
  const name = category.name?.de || category.name?.en || categorySlug;
  const description = `${name} bei Leihfluss mieten: flexibel für eine Woche, einen Monat oder tageweise. Lieferung in Deutschland.`;
  const canonical = absoluteUrl(`/rental/${encodeURIComponent(categorySlug)}`);
  return {
    title: `${name} mieten | ${SITE_NAME}`,
    description,
    alternates: { canonical },
    openGraph: { type: "website", siteName: SITE_NAME, locale: "de_DE", url: canonical, title: `${name} mieten | ${SITE_NAME}`, description },
  };
}

export default async function CategoryPage({ params }: Params) {
  const { categorySlug } = await params;
  const category = findCategory(await fetchCategoryTree(), categorySlug);
  if (!category) notFound();
  const slugs = new Set(descendantSlugs(category));
  const products = (await getProductsForSeo()).filter((product) => product.category?.slug && slugs.has(product.category.slug));
  const name = category.name?.de || category.name?.en || categorySlug;

  return (
    <div className="min-h-screen bg-white">
      <ClientNavbar />
      <JsonLd data={breadcrumbJsonLd([{ name: "Start", path: "/" }, { name, path: `/rental/${categorySlug}` }])} />
      <main className="mx-auto w-full max-w-[1280px] px-4 pb-16 pt-8">
        <nav aria-label="Breadcrumb" className="text-sm text-zinc-500">
          <Link href="/" className="hover:underline">Start</Link> / <span className="text-zinc-800">{name}</span>
        </nav>
        <h1 className="mt-3 text-3xl font-extrabold text-zinc-900">{name} mieten</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-600">
          {name} flexibel mieten statt kaufen. Alle Angebote mit Lieferung in Deutschland.{" "}
          <Link href="/shop" className="font-semibold text-[rgb(47,118,135)] underline">Zum gesamten Sortiment</Link>
        </p>
        {products.length === 0 ? (
          <p className="mt-8 text-zinc-600">In dieser Kategorie gibt es gerade keine Angebote.</p>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5 lg:grid-cols-4">
            {products.map((product) => (
              <RentalProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </main>
      <HomeFooter />
    </div>
  );
}
