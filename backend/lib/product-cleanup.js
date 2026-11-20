"use strict";

// The only collections the product cleanup may touch. Categories, brands,
// banners, users, admins, orders, blog posts and Cloudinary assets are never
// read or written here.
const CLEANUP_TARGETS = [
  ["Products", "Product"],
  ["ProductDrafts", "ProductDraft"],
  ["ProductPackages (queue)", "ProductPackage"],
];

async function countProductData(models) {
  const counts = [];
  for (const [label, key] of CLEANUP_TARGETS) counts.push({ label, key, count: await models[key].countDocuments({}) });
  return counts;
}

async function deleteProductData(models) {
  const deleted = [];
  for (const [label, key] of CLEANUP_TARGETS) {
    const result = await models[key].deleteMany({});
    deleted.push({ label, key, deleted: result.deletedCount || 0 });
  }
  return deleted;
}

module.exports = { CLEANUP_TARGETS, countProductData, deleteProductData };
