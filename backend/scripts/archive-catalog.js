#!/usr/bin/env node

// Safely clears the ACTIVE catalog: products are hidden, never deleted, and a full
// backup is written first. Dry run by default.
//
//   node scripts/archive-catalog.js                      show what would change
//   node scripts/archive-catalog.js --apply              back up, ask to confirm, then hide
//   node scripts/archive-catalog.js --restore <backup>   re-activate what that backup hid
//   --out <dir>   backup folder (default ~/leihfluss-backups)
//
// Reads MONGODB_URI from the environment; the database host is printed before any change.

require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const mongoose = require("mongoose");
const { connectDatabase } = require("../db");
const Product = require("../models/Product");
const ProductDraft = require("../models/ProductDraft");
const { snapshotActiveProducts, archiveActiveProducts, restoreFromBackup } = require("../lib/catalog-archive");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? String(process.argv[i + 1] || "").trim() : "";
};
const flag = (name) => process.argv.includes(`--${name}`);

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });

async function run() {
  await connectDatabase();
  const host = mongoose.connection.host;
  console.log(`Database host: ${host}`);

  if (arg("restore")) {
    const backup = JSON.parse(fs.readFileSync(arg("restore"), "utf8"));
    const answer = await ask(`Re-activate ${backup.activeProductIds.length} products on ${host}? Type RESTORE: `);
    if (answer.trim() !== "RESTORE") throw new Error("Not confirmed. Nothing changed.");
    const result = await restoreFromBackup(Product, backup);
    console.log(`Restored ${result.restored} products.`);
    return;
  }

  const active = await snapshotActiveProducts(Product);
  const drafts = await Product.countDocuments({ isActive: false });
  console.log(`Active products: ${active.length}. Inactive (drafts and hidden): ${drafts}.`);
  active.slice(0, 15).forEach((p) => console.log(`  - ${p.title} (${p.slug})`));
  if (active.length > 15) console.log(`  ... and ${active.length - 15} more`);

  if (!flag("apply")) {
    console.log("Dry run only. Nothing changed. Re-run with --apply to back up and hide these products.");
    return;
  }
  if (active.length === 0) return console.log("Nothing to archive.");

  const outDir = arg("out") || path.join(os.homedir(), "leihfluss-backups");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `catalog-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const allDrafts = await ProductDraft.find().lean();
  fs.writeFileSync(
    file,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      host,
      activeProductIds: active.map((p) => String(p._id)),
      products: active,
      drafts: allDrafts,
    }),
    { mode: 0o600 }
  );
  console.log(`Backup written: ${file}`);

  const answer = await ask(`Hide ${active.length} products from the storefront on ${host}? Type ARCHIVE ${active.length}: `);
  if (answer.trim() !== `ARCHIVE ${active.length}`) throw new Error("Not confirmed. Nothing changed (the backup file remains).");
  const result = await archiveActiveProducts(Product);
  console.log(`Archived ${result.archived} products. They are hidden, not deleted. To undo: --restore ${file}`);
}

run()
  .then(() => mongoose.disconnect().then(() => process.exit(0)))
  .catch(async (error) => {
    console.error(error.message);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
