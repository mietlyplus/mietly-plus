export function buildRentalProductPath(categorySlug: string, productSlug: string) {
  return `/rental/${encodeURIComponent(categorySlug)}/${encodeURIComponent(productSlug)}`;
}

export function buildProductPath(options: {
  categorySlug?: string | null;
  productSlug: string;
}) {
  const productSlug = String(options.productSlug || "").trim();
  if (!productSlug) return "/shop";

  const categorySlug = String(options.categorySlug || "").trim();
  if (categorySlug) {
    return buildRentalProductPath(categorySlug, productSlug);
  }

  return `/product/${encodeURIComponent(productSlug)}`;
}
