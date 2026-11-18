import { notFound, permanentRedirect } from "next/navigation";
import { getProductForSeo, productPath } from "@/lib/seo";

// Old product URLs (/product/<slug>) redirect permanently to the canonical
// category URL, on the server, so search engines transfer the old address.
export default async function LegacyProductPageRedirect({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProductForSeo(slug);
  if (!product) notFound();
  if (!product.category?.slug) permanentRedirect("/shop");
  permanentRedirect(productPath(product));
}
