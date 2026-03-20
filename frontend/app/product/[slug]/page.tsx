"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchPublicProductBySlug } from "@/lib/api";
import { buildRentalProductPath } from "@/lib/product-path";

export default function LegacyProductPageRedirect() {
  const router = useRouter();
  const params = useParams();
  const slugParam = params?.slug;
  const slug = Array.isArray(slugParam) ? String(slugParam[0] || "") : String(slugParam || "");

  useEffect(() => {
    if (!slug) {
      router.replace("/shop");
      return;
    }

    fetchPublicProductBySlug(slug)
      .then((product) => {
        const categorySlug = String(product?.category?.slug || "").trim();
        if (!categorySlug) {
          router.replace("/shop");
          return;
        }

        router.replace(buildRentalProductPath(categorySlug, slug));
      })
      .catch(() => {
        router.replace("/shop");
      });
  }, [router, slug]);

  return null;
}
