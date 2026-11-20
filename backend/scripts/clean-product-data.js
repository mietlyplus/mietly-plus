#!/usr/bin/env node

// Removes ALL product data: Products, ProductDrafts and ProductPackages (the AI queue).
// Dry run by default. Nothing else is touched: categories, brands, banners, users,
// admins, orders, blog posts, Stripe and Cloudinary assets stay as they are.
//
//   node scripts/clean-product-data.js           print the database host and counts only
//   node scripts/clean-product-data.js --apply   print them, then require typed confirmation
//
// Reads MONGODB_URI from the environment. There is no way to skip the confirmation.

require("dotenv").config();
const readline = require("readline");
const mongoose = require("mongoose");
const { connectDatabase } = require("../db");
const { countProductData, deleteProductData } = require("../lib/product-cleanup");

const models = {
  Product: require("../models/Product"),
  ProductDraft: require("../models/ProductDraft"),
  ProductPackage: require("../models/ProductPackage"),
};

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });

async function run() {
  await connectDatabase();
  const { host, name } = mongoose.connection;
  console.log(`Database host: ${host}`);
  console.log(`Database name: ${name}`);

  const counts = await countProductData(models);
  counts.forEach((entry) => console.log(`  ${entry.label}: ${entry.count}`));
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  console.log("Not touched: categories, brands, banners, users, admins, orders, blog, Stripe, Cloudinary.");

  if (!process.argv.includes("--apply")) {
    console.log("Dry run only. Nothing was deleted. Re-run with --apply to delete.");
    return;
  }
  if (total === 0) return console.log("Nothing to delete.");

  const phrase = `DELETE ${total} PRODUCT RECORDS FROM ${host}`;
  const answer = await ask(`This permanently deletes ${total} records and cannot be undone.\nType exactly: ${phrase}\n> `);
  if (answer.trim() !== phrase) throw new Error("Confirmation did not match. Nothing was deleted.");

  const deleted = await deleteProductData(models);
  deleted.forEach((entry) => console.log(`Deleted ${entry.deleted} from ${entry.label}.`));
}

run()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
