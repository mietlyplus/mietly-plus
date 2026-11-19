import type { Product } from "@/lib/types";
import { fetchPublicProductBySlug, fetchPublicProducts, fetchCategoryTree } from "@/lib/api";

// The canonical host. leihfluss.de redirects to www, so www is the one search
// engines should index.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.leihfluss.de").replace(/\/+$/, "");
export const SITE_NAME = "Leihfluss";

export function absoluteUrl(path: string) {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function getProductForSeo(slug: string): Promise<Product | null> {
  try {
    return await fetchPublicProductBySlug(slug);
  } catch {
    return null;
  }
}

export async function getProductsForSeo(): Promise<Product[]> {
  try {
    return await fetchPublicProducts();
  } catch {
    return [];
  }
}

export { fetchCategoryTree };

function clip(text: string, max: number) {
  const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** German-first product SEO. Uses the package-supplied fields when present. */
export function productMetadataFields(product: Product) {
  const title = product.titleI18n?.de || product.title;
  const metaTitle = product.seo?.metaTitle?.trim() || `${title} mieten | Leihfluss`;
  const description =
    product.seo?.metaDescription?.trim() ||
    clip(product.shortDescriptionI18n?.de || product.shortDescription || product.descriptionI18n?.de || product.description || `${title} bei Leihfluss mieten.`, 160);
  const images = [product.imageUrl, ...(product.galleryImages || [])].filter(Boolean);
  return { title, metaTitle, description, images, keywords: product.seo?.metaKeywords?.length ? product.seo.metaKeywords : product.tags };
}

export function productPath(product: Product) {
  const category = product.category?.slug;
  return category ? `/rental/${encodeURIComponent(category)}/${encodeURIComponent(product.slug)}` : `/product/${encodeURIComponent(product.slug)}`;
}

/** schema.org Product with rental prices as an AggregateOffer. Only emitted with a real price. */
export function productJsonLd(product: Product) {
  const { title, description, images } = productMetadataFields(product);
  const prices =
    product.rentalMode === "occasion"
      ? (product.occasionPricing || []).map((o) => o.price)
      : [product.buyerPrice, product.monthlyBuyerPrice, product.monthlyPrice].filter((p) => p > 0);
  const url = absoluteUrl(product.seo?.canonicalUrl ? new URL(product.seo.canonicalUrl, SITE_URL).pathname : productPath(product));
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: title,
    description,
    image: images,
    url,
    ...(product.brand ? { brand: { "@type": "Brand", name: product.brand } } : {}),
    ...(product.model ? { model: product.model } : {}),
    ...(product.sku ? { sku: product.sku } : {}),
    ...(product.identifiers?.gtin || product.identifiers?.ean ? { gtin: product.identifiers.gtin || product.identifiers.ean } : {}),
    ...(product.identifiers?.mpn ? { mpn: product.identifiers.mpn } : {}),
    ...(product.category?.name ? { category: product.category.name.de || product.category.name.en } : {}),
    ...(prices.length
      ? {
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "EUR",
            lowPrice: Math.min(...prices),
            highPrice: Math.max(...prices),
            offerCount: prices.length,
            availability: product.stockStatus === "out_of_stock" ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
            url,
          },
        }
      : {}),
  };
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}
