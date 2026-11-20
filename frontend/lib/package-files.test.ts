import test from "node:test";
import assert from "node:assert/strict";
import { planPackageFiles, attachUploadedImages } from "./package-files.ts";

const pkg = (id: string, files: string[]) =>
  JSON.stringify({ externalId: id, titles: { de: id }, images: files.map((file) => ({ file, origin: "owner_photo" })) });

test("matches images to JSON by exact filename and reports missing/unused", async () => {
  const plan = planPackageFiles(
    [
      { name: "battlefield.json", text: pkg("battlefield", ["battlefield-front.webp", "battlefield-back.webp"]) },
      { name: "broken.json", text: pkg("broken", ["Nope.webp", "battlefield-front.webp"]) },
      { name: "bad.json", text: "{ nope" },
    ],
    ["battlefield-front.webp", "battlefield-back.webp", "stray.png"]
  );
  const [ok, broken, bad] = plan.plans;
  assert.equal(ok.status, "READY");
  assert.equal(ok.imageCount, 2);
  assert.equal(broken.status, "INVALID");
  assert.deepEqual(broken.missingImages, ["Nope.webp"]);
  assert.equal(bad.status, "INVALID");
  assert.deepEqual(plan.unusedImages, ["stray.png"]);

  const uploads: string[] = [];
  const files = new Map([["battlefield-front.webp", new File(["a"], "battlefield-front.webp")], ["battlefield-back.webp", new File(["b"], "battlefield-back.webp")]]);
  const ready = await attachUploadedImages(plan, files, async (file) => { uploads.push(file.name); return `https://hosted/${file.name}`; });
  assert.equal(ready.length, 1, "only READY packages are submitted");
  assert.deepEqual(ready[0].images?.map((i) => i.url), ["https://hosted/battlefield-front.webp", "https://hosted/battlefield-back.webp"]);
  assert.equal(uploads.length, 2);
});
