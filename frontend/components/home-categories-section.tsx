"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchCategoryTree } from "@/lib/api";
import { Category } from "@/lib/types";
import { useSiteLocale } from "@/lib/use-site-locale";

const categoryCopy = {
  en: { title: "Rent By Category", featured: "Featured", left: "Slide categories left", right: "Slide categories right" },
  de: { title: "Nach Kategorie mieten", featured: "Empfohlen", left: "Kategorien nach links", right: "Kategorien nach rechts" },
};

export function HomeCategoriesSection() {
  const { locale } = useSiteLocale("de");
  const [categories, setCategories] = useState<Category[]>([]);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCategoryTree()
      .then((data) => setCategories(data))
      .catch((error) => {
        console.error("Failed to load categories:", error);
      });
  }, []);

  const categoriesWithImages = useMemo(
    () => categories.filter((category) => !category.parentId && Boolean(category.image)),
    [categories]
  );

  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;

    const updateButtons = () => {
      const maxScroll = slider.scrollWidth - slider.clientWidth;
      setShowControls(maxScroll > 6);
      setCanScrollLeft(slider.scrollLeft > 2);
      setCanScrollRight(slider.scrollLeft < maxScroll - 2);
    };

    updateButtons();
    slider.addEventListener("scroll", updateButtons);
    window.addEventListener("resize", updateButtons);
    return () => {
      slider.removeEventListener("scroll", updateButtons);
      window.removeEventListener("resize", updateButtons);
    };
  }, [categoriesWithImages.length]);

  const slideLeft = () => {
    sliderRef.current?.scrollBy({ left: -320, behavior: "smooth" });
  };

  const slideRight = () => {
    sliderRef.current?.scrollBy({ left: 320, behavior: "smooth" });
  };

  if (categoriesWithImages.length === 0) {
    return null;
  }

  return (
    <section className="mx-auto w-full max-w-[1280px] px-4 py-8">
      <div className="mb-5 flex items-end justify-between">
        <h2 className="text-2xl font-bold text-zinc-900 md:text-3xl">{categoryCopy[locale].title}</h2>
        <span className="text-sm font-medium text-[rgb(73,153,173)]">{categoryCopy[locale].featured}</span>
      </div>

      <div className="relative mx-auto max-w-[1120px] px-12">
        {showControls ? (
          <button
            type="button"
            onClick={slideLeft}
            disabled={!canScrollLeft}
            className="absolute left-0 top-[34%] z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-[rgb(73,153,173)] text-xl font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={categoryCopy[locale].left}
          >
            &lt;
          </button>
        ) : null}

        <div
          ref={sliderRef}
          className="mx-auto flex max-w-[980px] gap-5 overflow-x-auto pb-2"
          style={{ scrollbarWidth: "none" }}
        >
          {categoriesWithImages.map((category) => (
            <a key={category.id} href={`/rental/${category.slug}`} className="min-w-[140px] text-center">
              <div className="mx-auto h-24 w-24 rounded-full border border-[rgba(73,153,173,0.22)] bg-[rgba(73,153,173,0.10)] p-1 md:h-28 md:w-28">
                <div
                  className="h-full w-full rounded-full bg-cover bg-center"
                  style={{ backgroundImage: `url(${category.image})` }}
                />
              </div>
              <p className="mt-3 text-sm font-medium text-zinc-800">{category.name[locale] || category.name.en}</p>
            </a>
          ))}
        </div>

        {showControls ? (
          <button
            type="button"
            onClick={slideRight}
            disabled={!canScrollRight}
            className="absolute right-0 top-[34%] z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-[rgb(73,153,173)] text-xl font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={categoryCopy[locale].right}
          >
            &gt;
          </button>
        ) : null}
      </div>
    </section>
  );
}

