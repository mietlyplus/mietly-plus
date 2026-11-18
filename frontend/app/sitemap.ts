import type { MetadataRoute } from "next";
import type { Category } from "@/lib/types";
import { SITE_URL, fetchCategoryTree, getProductsForSeo, productPath } from "@/lib/seo";

export const revalidate = 3600;

function flatten(categories: Category[]): Category[] {
  return categories.flatMap((category) => [category, ...flatten(category.children || [])]);
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [products, categories] = await Promise.all([getProductsForSeo(), fetchCategoryTree()]);
  const staticPages = ["", "/shop", "/how-it-works", "/help-center", "/blog"].map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: "weekly" as const,
    priority: path === "" ? 1 : 0.6,
  }));
  return [
    ...staticPages,
    ...flatten(categories).map((category) => ({
      url: `${SITE_URL}/rental/${encodeURIComponent(category.slug)}`,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...products.map((product) => ({
      url: `${SITE_URL}${productPath(product)}`,
      lastModified: product.updatedAt ? new Date(product.updatedAt) : undefined,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
