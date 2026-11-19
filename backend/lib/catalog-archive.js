"use strict";

// Catalog reset without deleting anything: every currently active product is
// made inactive (hidden from the storefront), and the exact list is written to a
// backup so the step can be reversed. Orders and drafts are never touched.

async function snapshotActiveProducts(Product) {
  return Product.find({ isActive: { $ne: false } }).lean();
}

async function archiveActiveProducts(Product) {
  const active = await snapshotActiveProducts(Product);
  const ids = active.map((product) => product._id);
  if (ids.length) await Product.updateMany({ _id: { $in: ids } }, { $set: { isActive: false } });
  return { archived: ids.length, ids: ids.map(String), products: active };
}

/** Re-activates exactly the products a backup lists as having been active. */
async function restoreFromBackup(Product, backup) {
  const ids = (backup?.activeProductIds || []).filter(Boolean);
  if (!ids.length) return { restored: 0 };
  const result = await Product.updateMany({ _id: { $in: ids } }, { $set: { isActive: true } });
  return { restored: result.modifiedCount ?? ids.length };
}

module.exports = { snapshotActiveProducts, archiveActiveProducts, restoreFromBackup };
