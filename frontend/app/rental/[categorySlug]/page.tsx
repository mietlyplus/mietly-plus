import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CategoryLandingContent } from "@/components/category-landing-content";
import { JsonLd } from "@/components/json-ld";
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
    <>
      <JsonLd data={breadcrumbJsonLd([{ name: "Start", path: "/" }, { name, path: `/rental/${categorySlug}` }])} />
      <CategoryLandingContent name={name} nameEn={category.name?.en || ""} products={products} />
    </>
  );
}
