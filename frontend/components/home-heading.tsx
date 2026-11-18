"use client";

import { useSiteLocale } from "@/lib/use-site-locale";

const headingCopy = {
  de: {
    title: "Produkte flexibel mieten statt kaufen",
    text: "Technik und Alltagsgeräte wochen- oder monatsweise leihen, für Feiern auch tageweise. Mit Lieferung in Deutschland.",
  },
  en: {
    title: "Rent products flexibly instead of buying",
    text: "Rent electronics and everyday appliances by the week or month, and party equipment by the day. Delivered across Germany.",
  },
};

/** The homepage's single H1. */
export function HomeHeading() {
  const { locale } = useSiteLocale("de");
  const t = headingCopy[locale];
  return (
    <section className="mx-auto w-full max-w-[1280px] px-4 pt-6 md:pt-8">
      <h1 className="text-2xl font-extrabold tracking-tight text-zinc-900 md:text-4xl">{t.title}</h1>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600 md:text-base">{t.text}</p>
    </section>
  );
}
