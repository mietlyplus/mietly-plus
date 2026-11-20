// Pure planning for the AI Product Queue upload: one drop zone takes JSON
// package files and the image files they reference. Images are matched to the
// JSON by exact filename. Nothing here touches the network.

export type PackageImage = { url?: string; file?: string; [key: string]: unknown };
export type RawPackage = { externalId?: string; titles?: { de?: string; en?: string }; images?: PackageImage[]; [key: string]: unknown };

export type PackagePlan = {
  source: string;
  externalId: string;
  title: string;
  status: "READY" | "INVALID";
  imageCount: number;
  missingImages: string[];
  errors: string[];
  package: RawPackage | null;
};

export type UploadPlan = {
  plans: PackagePlan[];
  unusedImages: string[];
};

/** Accepts one package, an array of packages, or { packages: [...] }. */
export function extractPackages(parsed: unknown): RawPackage[] {
  if (Array.isArray(parsed)) return parsed as RawPackage[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { packages?: unknown }).packages)) {
    return (parsed as { packages: RawPackage[] }).packages;
  }
  return parsed && typeof parsed === "object" ? [parsed as RawPackage] : [];
}

export function planPackageFiles(jsonFiles: { name: string; text: string }[], imageNames: string[]): UploadPlan {
  const available = new Set(imageNames);
  const referenced = new Set<string>();
  const plans: PackagePlan[] = [];

  for (const file of jsonFiles) {
    let packages: RawPackage[];
    try {
      packages = extractPackages(JSON.parse(file.text));
    } catch {
      plans.push({ source: file.name, externalId: "", title: file.name, status: "INVALID", imageCount: 0, missingImages: [], errors: ["Not valid JSON."], package: null });
      continue;
    }
    if (packages.length === 0) {
      plans.push({ source: file.name, externalId: "", title: file.name, status: "INVALID", imageCount: 0, missingImages: [], errors: ["No package found in this file."], package: null });
      continue;
    }
    for (const pkg of packages) {
      const title = String(pkg?.titles?.de || pkg?.titles?.en || "").trim();
      const images = Array.isArray(pkg?.images) ? pkg.images : [];
      const missing: string[] = [];
      let imageCount = 0;
      for (const image of images) {
        if (image?.url) { imageCount += 1; continue; }
        const name = String(image?.file || "").trim();
        if (!name) continue;
        if (available.has(name)) { referenced.add(name); imageCount += 1; }
        else if (!missing.includes(name)) missing.push(name);
      }
      const errors: string[] = [];
      if (!title) errors.push("No title (titles.de or titles.en).");
      if (missing.length) errors.push(`Missing image file(s): ${missing.join(", ")}.`);
      plans.push({
        source: file.name,
        externalId: String(pkg?.externalId || ""),
        title: title || file.name,
        status: errors.length ? "INVALID" : "READY",
        imageCount,
        missingImages: missing,
        errors,
        package: pkg,
      });
    }
  }

  return { plans, unusedImages: imageNames.filter((name) => !referenced.has(name)) };
}

/**
 * Returns the READY packages with every `file` image replaced by its hosted URL.
 * `upload` is called once per distinct file.
 */
export async function attachUploadedImages(
  plan: UploadPlan,
  files: Map<string, File>,
  upload: (file: File) => Promise<string>
): Promise<RawPackage[]> {
  const hosted = new Map<string, string>();
  const out: RawPackage[] = [];
  for (const item of plan.plans) {
    if (item.status !== "READY" || !item.package) continue;
    const pkg = structuredClone(item.package);
    for (const image of pkg.images || []) {
      if (image.url || !image.file) continue;
      const file = files.get(String(image.file));
      if (!file) continue;
      if (!hosted.has(file.name)) hosted.set(file.name, await upload(file));
      image.url = hosted.get(file.name);
      delete image.file;
    }
    out.push(pkg);
  }
  return out;
}
