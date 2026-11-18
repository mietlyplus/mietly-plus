"use client";

import { useEffect } from "react";
import { useSiteLocale } from "@/lib/use-site-locale";

/** Keeps <html lang> in step with the language toggle (German by default). */
export function LocaleHtmlSync() {
  const { locale } = useSiteLocale("de");
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return null;
}
