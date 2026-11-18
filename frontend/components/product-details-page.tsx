"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ClientNavbar } from "@/components/client-navbar";
import { HomeFooter } from "@/components/home-footer";
import { RentalProductCard } from "@/components/rental-product-card";
import { fetchPublicProductBySlug, fetchPublicProducts } from "@/lib/api";
import { addCartItem } from "@/lib/cart";
import { earliestStartDate } from "@/lib/delivery-date";
import { useSiteLocale } from "@/lib/use-site-locale";
import { useWishlist } from "@/lib/use-wishlist";
import { Product } from "@/lib/types";

function formatAmount(value: number) {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function normalizeImages(product: Product) {
  const set = new Set<string>();
  if (product.imageUrl) set.add(product.imageUrl);
  (product.galleryImages || []).forEach((image) => {
    if (image) set.add(image);
  });
  return [...set];
}

function getDurationRange(product: Product, mode: "week" | "month") {
  if (mode === "month") {
    const minMonths = Math.max(1, product.minimumRentalMonths || 1);
    const maxMonths = Math.max(minMonths, product.maximumRentalMonths || minMonths);
    return { min: minMonths, max: maxMonths };
  }

  const minWeeksFromDays = Math.max(1, Math.ceil((product.minimumRentalDays || 7) / 7));
  const maxWeeksFromDays = Math.max(minWeeksFromDays, Math.ceil((product.maximumRentalDays || 30) / 7));
  const minWeeks = Math.max(1, product.minimumRentalWeeks || minWeeksFromDays);
  const maxWeeks = Math.max(minWeeks, product.maximumRentalWeeks || maxWeeksFromDays);
  return { min: minWeeks, max: maxWeeks };
}

function durationText(value: number, unit: Product["rentalPeriodUnit"], locale: "en" | "de") {
  const c = pdpCopy[locale];
  if (unit === "month") return `${value} ${value > 1 ? c.months : c.month}`;
  if (unit === "day") return `${value} ${value > 1 ? c.days : c.day}`;
  return `${value} ${value > 1 ? c.weeks : c.week}`;
}

const productNotesCopy = {
  en: {
    delivery: "Final delivery costs are shown at checkout.",
    verification: "Verification may be required for selected products based on value, category, or risk profile.",
    rentalPeriod: "Minimum rental period depends on the product category. Rentals start from 7 days.",
    rentalUseNotice: "This product is provided for temporary use and remains in Leihfluss inventory.",
  },
  de: {
    delivery: "Die finalen Versandkosten werden im Checkout angezeigt.",
    verification: "Für ausgewählte Produkte kann abhängig von Wert, Kategorie oder Risikoprofil eine Verifizierung erforderlich sein.",
    rentalPeriod: "Die Mindestmietdauer hängt von der Produktkategorie ab. Vermietungen starten ab 7 Tagen.",
    rentalUseNotice: "Dieses Produkt wird dir zur zeitweisen Nutzung überlassen und bleibt im Bestand von Leihfluss.",
  },
};

const pdpCopy = {
  en: {
    loading: "Loading product...", notFound: "Product not found.",
    allProducts: "All products", category: "Category",
    prevImage: "Previous image", nextImage: "Next image",
    selectPeriod: "Select your rental period", selectedLabel: "Selected:",
    byWeek: "Rent by week", byMonth: "Rent by month", startDate: "Start date",
    deposit: "Security deposit", idVerification: "Identity verification",
    idRequired: "Required for checkout", idNotRequired: "Not required",
    addToCart: "Add to cart", addedToCart: "Added to cart.", openCart: "Open cart",
    specsHeading: "Product specifications", showMore: "Show more", showLess: "Show less",
    specsSoon: "Specifications will be updated soon.", descHeading: "Description",
    alsoLike: "We think you may also like", scrollLeft: "Scroll related left", scrollRight: "Scroll related right",
    week: "week", weeks: "weeks", month: "month", months: "months",
    chooseDays: "Choose how many days",
    selected: "selected",
    day: "day", days: "days",
    includedTitle: "What's included",
    occasionNote: "Occasion rental for 1 to 7 days. Each duration has its own fixed price.",
    leadTime: (days: number, date: string) => `Delivery lead time: ${days} day${days === 1 ? "" : "s"}. Earliest start date: ${date}.`,
    dateTooEarly: (date: string) => `Please choose a start date on or after ${date}.`,
  },
  de: {
    loading: "Produkt wird geladen...", notFound: "Produkt nicht gefunden.",
    allProducts: "Alle Produkte", category: "Kategorie",
    prevImage: "Vorheriges Bild", nextImage: "Nächstes Bild",
    selectPeriod: "Mietdauer wählen", selectedLabel: "Gewählt:",
    byWeek: "Pro Woche mieten", byMonth: "Pro Monat mieten", startDate: "Startdatum",
    deposit: "Kaution", idVerification: "Identitätsprüfung",
    idRequired: "Beim Checkout erforderlich", idNotRequired: "Nicht erforderlich",
    addToCart: "In den Warenkorb", addedToCart: "Zum Warenkorb hinzugefügt.", openCart: "Warenkorb öffnen",
    specsHeading: "Produktspezifikationen", showMore: "Mehr anzeigen", showLess: "Weniger anzeigen",
    specsSoon: "Spezifikationen folgen in Kürze.", descHeading: "Beschreibung",
    alsoLike: "Das könnte dir auch gefallen", scrollLeft: "Nach links scrollen", scrollRight: "Nach rechts scrollen",
    week: "Woche", weeks: "Wochen", month: "Monat", months: "Monate",
    chooseDays: "Wie viele Tage?",
    selected: "gewählt",
    day: "Tag", days: "Tage",
    includedTitle: "Das ist enthalten",
    occasionNote: "Anlass-Miete für 1 bis 7 Tage. Jede Dauer hat ihren festen Preis.",
    leadTime: (days: number, date: string) => `Liefervorlauf: ${days} ${days === 1 ? "Tag" : "Tage"}. Frühester Mietstart: ${date}.`,
    dateTooEarly: (date: string) => `Bitte wähle ein Startdatum ab dem ${date}.`,
  },
};

export default function ProductDetailsPage() {
  const router = useRouter();
  const { locale } = useSiteLocale("de");
  const params = useParams();
  const slugParam = params?.slug;
  const slug = Array.isArray(slugParam) ? String(slugParam[0] || "") : String(slugParam || "");

  const [product, setProduct] = useState<Product | null>(null);
  const [related, setRelated] = useState<Product[]>([]);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [rentalMode, setRentalMode] = useState<"week" | "month">("week");
  const [activeDuration, setActiveDuration] = useState(1);
  const [occasionDays, setOccasionDays] = useState(0);
  const [deliveryDate, setDeliveryDate] = useState(earliestStartDate(2));
  const [showAllSpecs, setShowAllSpecs] = useState(false);
  const [cartFeedback, setCartFeedback] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const relatedRailRef = useRef<HTMLDivElement>(null);
  const { isWishlisted, toggleWishlist } = useWishlist();

  useEffect(() => {
    if (!slug) return;

    Promise.all([fetchPublicProductBySlug(slug), fetchPublicProducts()])
      .then(([currentProduct, allProducts]) => {
        setError("");
        setProduct(currentProduct);
        const isWeekly = (currentProduct.buyerPrice || 0) > 0 || (currentProduct.offerPrice || 0) > 0;
        const isMonthly = (currentProduct.monthlyBuyerPrice || 0) > 0 || (currentProduct.monthlyOfferPrice || 0) > 0 || (currentProduct.monthlyPrice || 0) > 0;
        const showW = isWeekly || (!isWeekly && !isMonthly);
        const showM = isMonthly || (!isWeekly && !isMonthly);

        let initialMode: "week" | "month" = currentProduct.rentalPeriodUnit === "month" ? "month" : "week";
        if (initialMode === "month" && !showM) initialMode = "week";
        if (initialMode === "week" && !showW) initialMode = "month";
        const range = getDurationRange(currentProduct, initialMode);
        setRentalMode(initialMode);
        setActiveDuration(range.min);
        setActiveImageIndex(0);

        const list = allProducts
          .filter(
            (item) =>
              item.id !== currentProduct.id &&
              item.isActive &&
              item.category?.id &&
              currentProduct.category?.id &&
              item.category.id === currentProduct.category.id
          )
          .slice(0, 12);
        setRelated(list);
      })
      .catch(() => {
        setError("not_found");
        setProduct(null);
      })
      .finally(() => setLoading(false));
  }, [slug]);

  const images = useMemo(() => (product ? normalizeImages(product) : []), [product]);
  const durationRange = useMemo(() => (product ? getDurationRange(product, rentalMode) : null), [product, rentalMode]);
  // One lead-time field per product (standard and occasion alike); 2 is the old default.
  const leadDays = Number.isInteger(product?.deliveryLeadDays) ? Number(product?.deliveryLeadDays) : 2;
  const minDeliveryDate = useMemo(() => earliestStartDate(leadDays), [leadDays]);
  // A chosen date earlier than the lead time is never used: the picker shows the earliest allowed one.
  const selectedStartDate = deliveryDate < minDeliveryDate ? minDeliveryDate : deliveryDate;

  const title = product?.titleI18n?.[locale] || product?.title || "";
  const altFor = (index: number) => product?.imageAlts?.[index]?.[locale] || product?.imageAlts?.[index]?.de || (index === 0 ? title : `${title} ${index + 1}`);
  const description = product?.descriptionI18n?.[locale] || product?.description || "";
  
  const currentImage = images[activeImageIndex] || product?.imageUrl || "";
  const weeklyBuyerPrice = product?.buyerPrice || 0;
  const weeklyOfferPrice = product?.offerPrice || 0;
  const weeklyHasOffer = weeklyBuyerPrice > 0 && weeklyOfferPrice > 0 && weeklyOfferPrice < weeklyBuyerPrice;
  const monthlyBuyerPrice = product?.monthlyBuyerPrice || 0;
  const monthlyOfferPrice = product?.monthlyOfferPrice || 0;
  const monthlyHasOffer = monthlyBuyerPrice > 0 && monthlyOfferPrice > 0 && monthlyOfferPrice < monthlyBuyerPrice;
  const weeklyUnitPrice = weeklyHasOffer
    ? weeklyOfferPrice
    : weeklyBuyerPrice > 0
      ? weeklyBuyerPrice
      : product?.monthlyPrice || 0;
  const monthlyUnitPrice = monthlyHasOffer
    ? monthlyOfferPrice
    : monthlyBuyerPrice > 0
      ? monthlyBuyerPrice
      : product?.monthlyPrice || 0;
  const effectiveUnitPrice = rentalMode === "month" ? monthlyUnitPrice : weeklyUnitPrice;
  const hasOffer = rentalMode === "week" ? weeklyHasOffer : monthlyHasOffer;
  const buyerPrice = rentalMode === "week" ? weeklyBuyerPrice : monthlyBuyerPrice;

  const isWeeklyAvailable = weeklyBuyerPrice > 0 || weeklyOfferPrice > 0;
  const isMonthlyAvailable = monthlyBuyerPrice > 0 || monthlyOfferPrice > 0 || (product?.monthlyPrice || 0) > 0;
  const showWeekly = isWeeklyAvailable || (!isWeeklyAvailable && !isMonthlyAvailable);
  const showMonthly = isMonthlyAvailable || (!isWeeklyAvailable && !isMonthlyAvailable);
  const multipliedOfferPrice = effectiveUnitPrice * activeDuration;
  const multipliedBuyerPrice = buyerPrice * activeDuration;
  // Occasion products rent by the day from explicit stored prices (never multiplied).
  const occasionOptions = product?.rentalMode === "occasion" ? [...(product.occasionPricing || [])].sort((a, b) => a.days - b.days) : [];
  const isOccasion = occasionOptions.length > 0;
  const selectedOccasion = occasionOptions.find((option) => option.days === occasionDays) || occasionOptions[0];
  const shownPrice = isOccasion ? selectedOccasion.price : multipliedOfferPrice;
  const shownDuration = isOccasion ? selectedOccasion.days : activeDuration;
  const shownUnit: Product["rentalPeriodUnit"] = isOccasion ? "day" : rentalMode;
  const shownHasOffer = !isOccasion && hasOffer;
  const visibleSpecs = showAllSpecs ? product?.specifications || [] : (product?.specifications || []).slice(0, 3);
  const productNotes = productNotesCopy[locale];
  const deliveryFee = Number(product?.deliveryFee || 0);
  const deliveryLine =
    locale === "de"
      ? `Lieferung in 1-4 Werktagen für €${formatAmount(deliveryFee)}.`
      : `Delivery in 1-4 business days for €${formatAmount(deliveryFee)}.`;

  const scrollRelated = (direction: "left" | "right") => {
    const rail = relatedRailRef.current;
    if (!rail) return;
    const card = rail.querySelector<HTMLElement>("[data-related-card]");
    const amount = card ? card.offsetWidth + 16 : 320;
    rail.scrollBy({ left: direction === "left" ? -amount * 2 : amount * 2, behavior: "smooth" });
  };

  const onAddToCart = () => {
    if (!product) return;
    if (selectedStartDate < minDeliveryDate) {
      setCartFeedback(pdpCopy[locale].dateTooEarly(minDeliveryDate));
      return;
    }
    addCartItem({
      productId: product.id,
      slug: product.slug,
      categorySlug: product.category?.slug || "",
      title: product.title,
      imageUrl: product.imageUrl,
      categoryName: product.category?.name.en || "General",
      brandName: product.brand || product.brandData?.name || "",
      unitPrice: shownPrice,
      baseUnitPrice: isOccasion ? shownPrice : effectiveUnitPrice,
      durationValue: shownDuration,
      durationUnit: shownUnit,
      startDate: selectedStartDate,
      quantity: 1,
      verificationRequired: product.verificationRequired !== false,
      depositEnabled: Boolean(product.depositEnabled),
      securityDeposit: Number(product.securityDeposit || 0),
      deliveryFee: Number(product.deliveryFee || 0),
    });
    setCartFeedback(pdpCopy[locale].addedToCart);
    window.setTimeout(() => setCartFeedback(""), 2500);
  };

  const onToggleWishlist = async (productId: string) => {
    try {
      await toggleWishlist(productId);
    } catch (err) {
      if (err instanceof Error && err.message === "LOGIN_REQUIRED") {
        router.push("/signin");
      }
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(73,153,173,0.14),rgba(73,153,173,0.04)_35%,#ffffff_72%)]">
      <ClientNavbar />

      <main className="mx-auto w-full max-w-[1280px] px-4 pb-16 pt-6">
        {loading ? (
          <div className="rounded-2xl border border-[rgba(73,153,173,0.25)] bg-white p-8 text-zinc-600 shadow-[0_16px_40px_-30px_rgba(73,153,173,0.6)]">
            {pdpCopy[locale].loading}
          </div>
        ) : null}

        {!loading && error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 text-rose-700 shadow-sm">{pdpCopy[locale].notFound}</div>
        ) : null}

        {!loading && product ? (
          <>
            <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-[rgba(73,153,173,0.2)] bg-white/80 px-3 py-2 text-sm text-zinc-600 backdrop-blur-sm">
              <Link href="/shop" className="font-semibold transition hover:text-[rgb(60,138,158)]">{pdpCopy[locale].allProducts}</Link>
              <span>&gt;</span>
              <Link
                href={`/shop?category=${product.category?.slug || ""}`}
                className="font-semibold transition hover:text-[rgb(60,138,158)]"
              >
                {product.category?.name[locale] || pdpCopy[locale].category}
              </Link>
              <span>&gt;</span>
              <span className="font-semibold text-zinc-900">{title}</span>
            </div>

            <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
              <div>
                <div className="relative flex h-[560px] items-center justify-center overflow-hidden rounded-3xl border border-[rgba(73,153,173,0.26)] bg-[linear-gradient(160deg,rgba(73,153,173,0.08),rgba(73,153,173,0.02)_45%,#ffffff_100%)] p-6 shadow-[0_20px_50px_-34px_rgba(73,153,173,0.75)]">
                  {images.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setActiveImageIndex((prev) => (prev - 1 + images.length) % images.length)}
                      className="absolute left-4 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-[rgba(73,153,173,0.35)] bg-white text-[rgb(47,118,135)] shadow-sm transition hover:border-[rgb(73,153,173)] hover:bg-[rgba(73,153,173,0.12)]"
                      aria-label={pdpCopy[locale].prevImage}
                    >
                      <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12.5 4.5L7 10l5.5 5.5" />
                      </svg>
                    </button>
                  ) : null}

                  {currentImage ? (
                    <img src={currentImage} alt={altFor(Math.max(0, images.indexOf(currentImage)))} className="h-full w-full object-contain" />
                  ) : null}

                  {images.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setActiveImageIndex((prev) => (prev + 1) % images.length)}
                      className="absolute right-4 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-[rgba(73,153,173,0.35)] bg-white text-[rgb(47,118,135)] shadow-sm transition hover:border-[rgb(73,153,173)] hover:bg-[rgba(73,153,173,0.12)]"
                      aria-label={pdpCopy[locale].nextImage}
                    >
                      <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M7.5 4.5L13 10l-5.5 5.5" />
                      </svg>
                    </button>
                  ) : null}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {images.map((image, index) => (
                    <button
                      key={`${image}-${index}`}
                      type="button"
                      onClick={() => setActiveImageIndex(index)}
                      className={`h-16 w-16 overflow-hidden rounded-xl border transition ${
                        index === activeImageIndex
                          ? "border-[rgb(73,153,173)] ring-2 ring-[rgba(73,153,173,0.22)]"
                          : "border-zinc-200 hover:border-[rgba(73,153,173,0.35)]"
                      }`}
                    >
                      <img src={image} alt={altFor(index)} className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-5">
                <div className="rounded-3xl border border-[rgba(73,153,173,0.28)] bg-white p-5 shadow-[0_18px_45px_-32px_rgba(73,153,173,0.65)]">
                  <h1 className="text-3xl font-extrabold text-zinc-900 md:text-[2.1rem]">{title}</h1>

                  {isOccasion ? (
                  <div className="mt-5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-zinc-800">{pdpCopy[locale].chooseDays}</p>
                      <span className="rounded-full border border-[rgba(73,153,173,0.25)] bg-[rgba(73,153,173,0.12)] px-3 py-1 text-xs font-bold text-[rgb(47,118,135)]">
                        {shownDuration} {shownDuration === 1 ? pdpCopy[locale].day : pdpCopy[locale].days} {pdpCopy[locale].selected}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {occasionOptions.map((option) => (
                        <button
                          key={option.days}
                          type="button"
                          onClick={() => setOccasionDays(option.days)}
                          className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                            option.days === shownDuration
                              ? "border-[rgb(73,153,173)] bg-[rgba(73,153,173,0.12)] text-[rgb(47,118,135)]"
                              : "border-zinc-200 text-zinc-600 hover:border-[rgba(73,153,173,0.35)]"
                          }`}
                        >
                          {option.days} {option.days === 1 ? pdpCopy[locale].day : pdpCopy[locale].days}
                          <span className="block text-xs font-bold">EUR {formatAmount(option.price)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  ) : (
                  <div className="mt-5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-zinc-800">{pdpCopy[locale].selectPeriod}</p>
                      <span className="rounded-full border border-[rgba(73,153,173,0.25)] bg-[rgba(73,153,173,0.12)] px-3 py-1 text-xs font-bold text-[rgb(47,118,135)]">
                        {durationText(activeDuration, rentalMode, locale)} selected
                      </span>
                    </div>
                    <div className={`mt-3 grid gap-2 ${showWeekly && showMonthly ? "grid-cols-2" : "grid-cols-1"}`}>
                      {showWeekly && (
                        <button
                          type="button"
                          onClick={() => {
                            setRentalMode("week");
                            if (product) {
                              const range = getDurationRange(product, "week");
                              setActiveDuration(range.min);
                            }
                          }}
                          className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                            rentalMode === "week"
                              ? "border-[rgb(73,153,173)] bg-[rgba(73,153,173,0.12)] text-[rgb(47,118,135)]"
                              : "border-zinc-200 text-zinc-600 hover:border-[rgba(73,153,173,0.35)]"
                          }`}
                        >
                          {pdpCopy[locale].byWeek}
                        </button>
                      )}
                      {showMonthly && (
                        <button
                          type="button"
                          onClick={() => {
                            setRentalMode("month");
                            if (product) {
                              const range = getDurationRange(product, "month");
                              setActiveDuration(range.min);
                            }
                          }}
                          className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                            rentalMode === "month"
                              ? "border-[rgb(73,153,173)] bg-[rgba(73,153,173,0.12)] text-[rgb(47,118,135)]"
                              : "border-zinc-200 text-zinc-600 hover:border-[rgba(73,153,173,0.35)]"
                          }`}
                        >
                          {pdpCopy[locale].byMonth}
                        </button>
                      )}
                    </div>
                    <div className="mt-3 rounded-2xl border border-[rgba(73,153,173,0.22)] bg-[linear-gradient(165deg,rgba(73,153,173,0.1),rgba(73,153,173,0.04)_52%,#ffffff_100%)] p-4">
                      <input
                        type="range"
                        min={durationRange?.min || 1}
                        max={durationRange?.max || 1}
                        step={1}
                        value={activeDuration}
                        onChange={(event) => setActiveDuration(Number(event.target.value))}
                        className="w-full accent-[rgb(73,153,173)]"
                      />
                      <div className="mt-2 flex items-center justify-between text-xs font-semibold text-zinc-500">
                        <span>{durationRange?.min || 1}+</span>
                        <span>{durationRange ? Math.round((durationRange.min + durationRange.max) / 2) : 1}+</span>
                        <span>{durationRange?.max || 1}+</span>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-zinc-600">
                      {pdpCopy[locale].selectedLabel} {durationText(activeDuration, rentalMode, locale)}
                    </p>
                  </div>
                  )}

                  <div className="mt-5">
                    <p className="text-sm font-semibold text-zinc-800">{pdpCopy[locale].startDate}</p>
                    <input
                      type="date"
                      min={minDeliveryDate}
                      value={selectedStartDate}
                      onChange={(event) => setDeliveryDate(event.target.value)}
                      className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-[rgb(73,153,173)]"
                    />
                    <p className="mt-1 text-xs text-zinc-500">{pdpCopy[locale].leadTime(leadDays, minDeliveryDate)}</p>
                  </div>

                  <div className="mt-5 border-t border-zinc-200 pt-4">
                    {shownHasOffer ? (
                      <div className="flex items-end gap-2">
                        <span className="text-2xl text-zinc-400 line-through">EUR {formatAmount(multipliedBuyerPrice)}</span>
                        <span className="text-4xl font-extrabold text-rose-600">EUR {formatAmount(multipliedOfferPrice)}</span>
                        <span className="pb-1 text-sm font-semibold text-zinc-700">/{durationText(activeDuration, rentalMode, locale)}</span>
                      </div>
                    ) : (
                      <div className="flex items-end gap-2">
                        <span className="text-4xl font-extrabold text-[rgb(47,118,135)]">EUR {formatAmount(shownPrice)}</span>
                        <span className="pb-1 text-sm font-semibold text-zinc-700">/{isOccasion ? `${shownDuration} ${shownDuration === 1 ? pdpCopy[locale].day : pdpCopy[locale].days}` : durationText(shownDuration, shownUnit, locale)}</span>
                      </div>
                    )}
                    {product.depositEnabled ? (
                      <p className="mt-2 text-sm text-zinc-600">{pdpCopy[locale].deposit}: EUR {formatAmount(product.securityDeposit || 0)}</p>
                    ) : null}
                    <p className="mt-2 text-sm text-zinc-600">
                      {pdpCopy[locale].idVerification}:{" "}
                      <span className="font-semibold text-zinc-800">
                        {product.verificationRequired ? pdpCopy[locale].idRequired : pdpCopy[locale].idNotRequired}
                      </span>
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={onAddToCart}
                    className="mt-5 inline-flex w-full items-center justify-center rounded-full bg-[rgb(73,153,173)] px-4 py-3 text-sm font-bold text-white shadow-[0_14px_30px_-20px_rgba(73,153,173,0.9)] transition hover:bg-[rgb(60,138,158)]"
                  >
                    {pdpCopy[locale].addToCart}
                  </button>
                  {cartFeedback ? (
                    <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-[rgba(73,153,173,0.25)] bg-[rgba(73,153,173,0.12)] px-3 py-2 text-xs font-semibold text-[rgb(47,118,135)]">
                      <span>{cartFeedback}</span>
                      <button type="button" onClick={() => router.push("/cart")} className="underline">
                        {pdpCopy[locale].openCart}
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-[rgba(73,153,173,0.25)] bg-[linear-gradient(160deg,rgba(73,153,173,0.08),rgba(73,153,173,0.03)_60%,#ffffff)] p-4 text-sm text-zinc-700">
                  <p className="font-semibold">{deliveryLine}</p>
                  <p className="mt-2">{productNotes.delivery}</p>
                  <p className="mt-2">{productNotes.verification}</p>
                  <p className="mt-2">{isOccasion ? pdpCopy[locale].occasionNote : productNotes.rentalPeriod}</p>
                  <p className="mt-2">{productNotes.rentalUseNotice}</p>
                </div>
              </div>
            </section>

            {(product.includedItems || []).length > 0 ? (
              <section className="mt-8 rounded-2xl border border-[rgba(73,153,173,0.24)] bg-white p-5 shadow-[0_16px_36px_-30px_rgba(73,153,173,0.55)]">
                <h2 className="text-3xl font-extrabold text-zinc-900">{pdpCopy[locale].includedTitle}</h2>
                <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-zinc-800">
                  {(product.includedItems || []).map((item, index) => (
                    <li key={`${item.de}-${index}`}>
                      {item.quantity > 1 ? `${item.quantity} × ` : ""}
                      {(locale === "en" ? item.en : item.de) || item.de || item.en}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="mt-8 rounded-2xl border border-[rgba(73,153,173,0.24)] bg-white p-5 shadow-[0_16px_36px_-30px_rgba(73,153,173,0.55)]">
              <h2 className="text-3xl font-extrabold text-zinc-900">{pdpCopy[locale].specsHeading}</h2>
              {(product.specifications || []).length > 0 ? (
                <div className="mt-5 space-y-4">
                  {visibleSpecs.map((spec, index) => (
                    <div key={`${spec.key}-${index}`} className="grid grid-cols-[160px_1fr] gap-4 text-sm">
                      <p className="font-bold uppercase tracking-wide text-zinc-600">{locale === "en" && spec.keyEn ? spec.keyEn : spec.key}</p>
                      <p className="text-zinc-800">{locale === "en" && spec.valueEn ? spec.valueEn : spec.value}</p>
                    </div>
                  ))}
                  {(product.specifications || []).length > 3 ? (
                    <button
                      type="button"
                      onClick={() => setShowAllSpecs((prev) => !prev)}
                      className="pt-2 text-sm font-semibold text-[rgb(47,118,135)] underline"
                    >
                      {showAllSpecs ? pdpCopy[locale].showLess : pdpCopy[locale].showMore}
                    </button>
                  ) : null}
                </div>
              ) : (
                <p className="mt-4 text-sm text-zinc-600">{pdpCopy[locale].specsSoon}</p>
              )}
            </section>

            {description ? (
              <section className="mt-8 rounded-2xl border border-[rgba(73,153,173,0.24)] bg-white p-5 shadow-[0_16px_36px_-30px_rgba(73,153,173,0.55)]">
                <h2 className="text-3xl font-extrabold text-zinc-900">{pdpCopy[locale].descHeading}</h2>
                <div className="prose mt-4 max-w-none text-zinc-700" dangerouslySetInnerHTML={{ __html: description }} />
              </section>
            ) : null}

            {related.length > 0 ? (
              <section className="mt-10">
                <div className="mb-5 flex items-end justify-between">
                  <h2 className="text-4xl font-extrabold text-zinc-900">{pdpCopy[locale].alsoLike}</h2>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => scrollRelated("left")}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-300 text-zinc-700 transition hover:border-[rgb(73,153,173)] hover:text-[rgb(47,118,135)]"
                      aria-label={pdpCopy[locale].scrollLeft}
                    >
                      <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12.5 4.5L7 10l5.5 5.5" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => scrollRelated("right")}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-300 text-zinc-700 transition hover:border-[rgb(73,153,173)] hover:text-[rgb(47,118,135)]"
                      aria-label={pdpCopy[locale].scrollRight}
                    >
                      <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M7.5 4.5L13 10l-5.5 5.5" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div
                  ref={relatedRailRef}
                  className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {related.map((item) => (
                    <RentalProductCard
                      key={item.id}
                      product={item}
                      wishlistActive={isWishlisted(item.id)}
                      onToggleWishlist={onToggleWishlist}
                      className="min-w-[290px] max-w-[290px] snap-start sm:min-w-[320px] sm:max-w-[320px]"
                      cardAttr={{ "data-related-card": "1" }}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </main>

      <HomeFooter />
    </div>
  );
}
