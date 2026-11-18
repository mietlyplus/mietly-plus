import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import { DesktopScaleWrapper } from "@/components/desktop-scale-wrapper";
import { CookieConsentPopup } from "@/components/cookie-consent-popup";
import { JsonLd } from "@/components/json-ld";
import { SITE_NAME, SITE_URL } from "@/lib/seo";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Leihfluss | Produkte flexibel mieten statt kaufen", template: "%s | Leihfluss" },
  description:
    "Leihfluss: Technik, Haushalt und mehr flexibel mieten statt kaufen. Wochen- oder monatsweise, für Feiern auch tageweise. Lieferung in Deutschland.",
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: SITE_NAME, locale: "de_DE", url: SITE_URL },
  twitter: { card: "summary_large_image" },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body className={`${manrope.variable} antialiased`}>
        <JsonLd
          data={{
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "Organization", "@id": `${SITE_URL}/#organization`, name: SITE_NAME, url: SITE_URL, logo: `${SITE_URL}/logo.png` },
              { "@type": "WebSite", "@id": `${SITE_URL}/#website`, url: SITE_URL, name: SITE_NAME, inLanguage: "de-DE", publisher: { "@id": `${SITE_URL}/#organization` } },
            ],
          }}
        />
        <DesktopScaleWrapper>
          {children}
          <CookieConsentPopup />
        </DesktopScaleWrapper>
      </body>
    </html>
  );
}
