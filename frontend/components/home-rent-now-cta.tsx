"use client";

import Link from "next/link";
import { useSiteLocale } from "@/lib/use-site-locale";

const ctaCopy = {
  en: {
    eyebrow: "Start Renting",
    title: "Get Products on Rent Now",
    text: "Browse all available products and pick the perfect rental plan for your needs.",
    button: "Go To Shop",
  },
  de: {
    eyebrow: "Jetzt mieten",
    title: "Produkte jetzt mieten",
    text: "Stöbere im gesamten Sortiment und wähle den passenden Mietplan für dich.",
    button: "Zum Shop",
  },
};

export function HomeRentNowCta() {
  const { locale } = useSiteLocale("de");
  const t = ctaCopy[locale];
  return (
    <section className="mx-auto w-full max-w-[1280px] px-4 pb-14">
      <div className="overflow-hidden rounded-3xl border border-[rgba(73,153,173,0.22)] bg-gradient-to-r from-[rgba(73,153,173,0.10)] via-white to-[rgba(73,153,173,0.14)] p-8 md:p-12">
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[rgb(73,153,173)]">{t.eyebrow}</p>
            <h3 className="mt-2 text-3xl font-extrabold text-zinc-900 md:text-4xl">
              {t.title}
            </h3>
            <p className="mt-3 max-w-2xl text-lg text-zinc-600">
              {t.text}
            </p>
          </div>

          <Link
            href="/shop"
            className="inline-flex min-h-14 items-center justify-center rounded-2xl bg-[rgb(73,153,173)] px-8 text-lg font-bold text-white shadow-sm transition hover:bg-[rgb(60,138,158)]"
          >
            {t.button}
          </Link>
        </div>
      </div>
    </section>
  );
}

