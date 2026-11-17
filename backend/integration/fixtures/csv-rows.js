"use strict";

// Mirrors the column mapping performed by the bulk import screen
// (frontend/app/admin/products/bulk/page.tsx) so the integration suite can
// exercise the real CSV -> Product path end to end.

const CSV_HEADER = [
  "Product Title (EN)", "Product Title (DE)", "Slug", "SKU", "Brand", "Category",
  "Short Description (EN)", "Long Description (EN) -",
  "Weekly Buyer Price (cut price)", "Weekly Offer Price",
  "Monthly Buyer Price (cut price)", "Monthly Offer Price", "Monthly Rental Price (base)",
  "Delivery Fee (EUR)", "Stock", "Min Rental (weeks)", "Max Rental (weeks)",
  "Max Rental Qty", "Unit", "Tags (comma-separated)", "Specifications (line: Key: Value)",
  "Meta Title", "Meta Description",
];

const CSV_ROW = [
  "CSV Tripod", "CSV Stativ", "csv-tripod", "TRI-1", "Sony", "Cameras",
  "A sturdy tripod.", "A sturdy tripod for field work.",
  "12", "", "35", "", "35",
  "4", "3", "1", "4",
  "2", "piece", "tripod,camera", "Height: 160 cm",
  "CSV Tripod mieten", "Rent the CSV Tripod",
];

function toCsv() {
  const escape = (value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return `${CSV_HEADER.map(escape).join(",")}\n${CSV_ROW.map(escape).join(",")}\n`;
}

/** Minimal CSV reader: enough for the fixture, quoted fields included. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((entry) => entry.some((cell) => cell !== ""));
  return body.map((entry) => Object.fromEntries(header.map((key, index) => [key, entry[index] ?? ""])));
}

const num = (value, fallback = 0) => {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** The same field mapping the bulk screen applies before POSTing. */
function mapCsvRowToProduct(row, { categoryId, brandId, imageUrl }) {
  const minWeeks = num(row["Min Rental (weeks)"], 1) || 1;
  const maxWeeks = num(row["Max Rental (weeks)"], 2) || 2;

  return {
    title: row["Product Title (EN)"],
    titleI18n: { en: row["Product Title (EN)"], de: row["Product Title (DE)"] },
    slug: row["Slug"],
    sku: row["SKU"],
    brand: row["Brand"],
    brandId,
    categoryId,
    imageUrl,
    shortDescription: row["Short Description (EN)"],
    description: row["Long Description (EN) -"],
    buyerPrice: num(row["Weekly Buyer Price (cut price)"]),
    offerPrice: num(row["Weekly Offer Price"]),
    monthlyBuyerPrice: num(row["Monthly Buyer Price (cut price)"]),
    monthlyOfferPrice: num(row["Monthly Offer Price"]),
    monthlyPrice: num(row["Monthly Rental Price (base)"]),
    deliveryFee: num(row["Delivery Fee (EUR)"]),
    stock: num(row["Stock"]),
    minimumRentalWeeks: minWeeks,
    maximumRentalWeeks: maxWeeks,
    minimumRentalDays: minWeeks * 7,
    maximumRentalDays: maxWeeks * 7,
    minimumRentalMonths: 1,
    maximumRentalMonths: 24,
    maxRentalQuantity: num(row["Max Rental Qty"], 1),
    unit: row["Unit"] || "piece",
    rentalPeriodUnit: "week",
    tags: String(row["Tags (comma-separated)"] || "").split(",").map((t) => t.trim()).filter(Boolean),
    specifications: String(row["Specifications (line: Key: Value)"] || "")
      .split("\n").map((line) => line.split(":")).filter((parts) => parts.length >= 2)
      .map((parts) => ({ key: parts[0].trim(), value: parts.slice(1).join(":").trim() })),
    seo: { metaTitle: row["Meta Title"], metaDescription: row["Meta Description"], metaKeywords: [] },
    isActive: true,
  };
}

module.exports = { CSV_HEADER, CSV_ROW, toCsv, parseCsv, mapCsvRowToProduct };
