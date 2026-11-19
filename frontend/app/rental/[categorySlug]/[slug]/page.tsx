import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ProductDetailsPage from "@/components/product-details-page";
import { JsonLd } from "@/components/json-ld";
import { SITE_NAME, absoluteUrl, breadcrumbJsonLd, getProductForSeo, productJsonLd, productMetadataFields, productPath } from "@/lib/seo";

type Params = { params: Promise<{ categorySlug: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductForSeo(slug);
  if (!product) return { title: "Produkt nicht gefunden", robots: { index: false, follow: false } };
  const { metaTitle, description, images, keywords } = productMetadataFields(product);
  const canonical = product.seo?.canonicalUrl?.trim() || absoluteUrl(productPath(product));
  return {
    title: { absolute: metaTitle },
    description,
    keywords,
    alternates: { canonical },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "de_DE",
      url: canonical,
      title: product.seo?.ogTitle?.trim() || metaTitle,
      description: product.seo?.ogDescription?.trim() || description,
      images: (product.seo?.ogImageUrl ? [product.seo.ogImageUrl] : images).slice(0, 3),
    },
    twitter: { card: "summary_large_image", title: metaTitle, description },
  };
}

export default async function RentalProductDetailsPage({ params }: Params) {
  const { slug } = await params;
  const product = await getProductForSeo(slug);
  if (!product) notFound();
  const categoryName = product.category?.name?.de || product.category?.name?.en || "Mieten";
  return (
    <>
      <JsonLd data={productJsonLd(product)} />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Start", path: "/" },
          { name: categoryName, path: product.category?.slug ? `/rental/${product.category.slug}` : "/shop" },
          { name: product.titleI18n?.de || product.title, path: productPath(product) },
        ])}
      />
      <ProductDetailsPage />
    </>
  );
}
