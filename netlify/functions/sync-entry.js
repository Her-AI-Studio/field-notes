// This repo's package.json has "type": "module", so Netlify treats every
// .js file here as an ES module -- exports.handler/require() don't exist
// in that scope (that's the "module is not defined" error). Written as
// real ESM below: static import, export const handler. This also means
// @octokit/rest (itself ESM-only) can be imported normally, no dynamic
// import() workaround needed.
import { Octokit } from "@octokit/rest";

const OWNER = "Her-AI-Studio";
const REPO = "field-notes";
const BASE_BRANCH = "main";

// Cloudinary configuration. All entry media (photos, sketches, AI sketches)
// is stored in Cloudinary and delivered back to the web app through
// Cloudinary's CDN so it can be optimized on the fly (format, quality,
// resizing) instead of committing image binaries to this repo.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_FOLDER = "field-notes";
// The reference image is used as a style guide for AI-generated field note
// sketches, keeping the visual aesthetic consistent across all generated images.
const REFERENCE_IMAGE_URL = "https://res.cloudinary.com/uq7m2iiz/image/upload/v1787166592/ai-field-notes_jmna4u.jpg";

function cloudinaryConfigured() {
  return Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}

// Insert an on-the-fly transformation into a Cloudinary delivery URL, just
// before the version segment ("/v1234/"). Because the transformation is a
// single path segment with no slashes and the version always begins with
// "/v<digits>/", this reliably targets the right spot whether or not the
// URL already carries a transformation.
function withTransformation(secureUrl, transformation) {
  return secureUrl.replace(
    /(\/upload\/)(?:[^/]+\/)?(v\d+\/)/,
    `$1${transformation}/$2`
  );
}

// GitHub's Contents API requires the current file's sha when a path
// already exists on the target branch/ref, and rejects the write if a
// sha is passed for a path that's genuinely new. Since the same catalog
// number can get resynced (testing, retries after a partial failure)
// and may have already landed on main from an earlier merge, every
// write here checks for an existing sha first rather than assuming
// create vs. update based on convention alone.
async function upsertFile(octokit, { path, branch, message, content }) {
  let sha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: OWNER, repo: REPO, path, ref: branch,
    });
    sha = Array.isArray(data) ? undefined : data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
    // 404 means the path doesn't exist yet on this branch -- a real
    // create, no sha needed.
  }

  return octokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, branch, path, message, content,
    ...(sha ? { sha } : {}),
  });
}

// Generate an AI field note sketch using Cloudinary's Image Generation API.
// Uses the image_to_image endpoint with the reference image as a style guide.
// The generated image is stored in Cloudinary as a managed asset; this returns
// { ok: true, url } with its secure_url so the site can deliver it straight
// from Cloudinary, or { ok: false, error } carrying the reason so callers can
// surface why generation failed instead of silently omitting the image.
async function generateAiSketch(noteText, slug) {
  if (!cloudinaryConfigured()) {
    console.warn("Cloudinary credentials not configured; skipping AI sketch generation");
    return { ok: false, error: "Cloudinary credentials not configured in Netlify environment" };
  }

  const prompt = [
    "Create a field sketch illustration in the style of the reference image [1].",
    "The sketch should depict:",
    noteText || "A natural world observation",
    "Use a vintage field journal aesthetic with earthy tones, hand-drawn quality, and scientific illustration style.",
  ].join(" ");

  try {
    const response = await fetch(
      `https://api.cloudinary.com/v2/generate/${CLOUDINARY_CLOUD_NAME}/image_to_image`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString("base64")}`,
        },
        body: JSON.stringify({
          prompt,
          reference_images: [
            {
              source_type: "url",
              url: REFERENCE_IMAGE_URL,
            },
          ],
          model: {
            family: "nano-banana",
            tier: "premium",
          },
          target: {
            target_type: "managed_asset",
            public_id: `field-notes/${slug}-ai`,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Cloudinary image generation failed (${response.status}): ${errorText}`);
      return { ok: false, error: `Cloudinary image generation failed (${response.status}): ${errorText.slice(0, 300)}` };
    }

    const data = await response.json();
    const asset = data?.data?.assets?.[0];
    if (!asset?.storage?.secure_url) {
      console.error("Cloudinary image generation returned no asset URL");
      return { ok: false, error: "Cloudinary image generation returned no asset URL" };
    }

    // The asset is already stored in Cloudinary as a managed asset (see the
    // image_to_image "target" above) -- deliver it from there instead of
    // downloading a copy and committing it to the repo.
    return { ok: true, url: asset.storage.secure_url };
  } catch (err) {
    console.error("Cloudinary image generation error:", err.message);
    return { ok: false, error: err.message };
  }
}

// Upload a base64-encoded image to Cloudinary under the given public_id
// (namespaced into CLOUDINARY_FOLDER) and return its secure delivery URL.
// Uses Basic Auth over the Upload API -- simpler than a hand-rolled
// signature for server-side calls, and the same auth scheme already used for
// image generation. Returns { ok: true, url } or { ok: false, error }.
async function uploadToCloudinary(base64, publicId, mimeType) {
  if (!cloudinaryConfigured()) {
    return { ok: false, error: "Cloudinary credentials not configured in Netlify environment" };
  }

  try {
    const form = new FormData();
    form.append("file", `data:${mimeType};base64,${base64}`);
    form.append("public_id", publicId);
    // Resyncs of the same catalog number overwrite the previous asset in
    // place (same public_id) rather than stacking duplicate uploads.
    form.append("overwrite", "true");

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString("base64")}`,
        },
        body: form,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Cloudinary upload failed (${response.status}): ${errorText}`);
      return { ok: false, error: `Cloudinary upload failed (${response.status}): ${errorText.slice(0, 300)}` };
    }

    const data = await response.json();
    if (!data?.secure_url) {
      return { ok: false, error: "Cloudinary upload returned no secure_url" };
    }
    return { ok: true, url: data.secure_url };
  } catch (err) {
    console.error("Cloudinary upload error:", err.message);
    return { ok: false, error: err.message };
  }
}

export const handler = async (event) => {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { catalog_no, timestamp, note, locality, weather, habitat, photo, sketch } = body;

  // Open endpoint, no auth -- but still reject obviously malformed or
  // oversized submissions before doing any GitHub API work.
  if (!catalog_no || !timestamp) {
    return { statusCode: 400, body: "catalog_no and timestamp are required" };
  }
  if (photo && Buffer.byteLength(photo, "base64") > 4 * 1024 * 1024) {
    return { statusCode: 413, body: "Photo too large" };
  }
  if (sketch && Buffer.byteLength(sketch, "base64") > 4 * 1024 * 1024) {
    return { statusCode: 413, body: "Sketch too large" };
  }

  const slug = catalog_no.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const branchName = `entry/${slug}-${Date.now()}`;

  try {
    // 1. Branch off the current tip of main
    const { data: mainRef } = await octokit.git.getRef({
      owner: OWNER, repo: REPO, ref: `heads/${BASE_BRANCH}`,
    });
    await octokit.git.createRef({
      owner: OWNER, repo: REPO,
      ref: `refs/heads/${branchName}`,
      sha: mainRef.object.sha,
    });

    // 2. Upload the photo to Cloudinary, if present. All entry media now
    //    lives in Cloudinary -- the repo only stores the markdown, which
    //    references Cloudinary delivery URLs. Delivering through Cloudinary's
    //    CDN gives format/quality optimization and on-the-fly resizing for
    //    free, and keeps image binaries out of git.
    let photoUrl = null;
    let photoError = null;
    if (photo) {
      const result = await uploadToCloudinary(photo, `${CLOUDINARY_FOLDER}/${slug}`, "image/jpeg");
      if (result.ok) {
        photoUrl = result.url;
      } else {
        photoError = result.error;
      }
    }

    // 3. Upload the hand-drawn sketch to Cloudinary, if present
    let sketchUrl = null;
    let sketchError = null;
    if (sketch) {
      const result = await uploadToCloudinary(sketch, `${CLOUDINARY_FOLDER}/${slug}-sketch`, "image/png");
      if (result.ok) {
        sketchUrl = result.url;
      } else {
        sketchError = result.error;
      }
    }

    // 3b. Generate an AI field note sketch using Cloudinary's Image
    // Generation API with the reference image, whether or not a photo
    // was also provided. Already stored in Cloudinary as a managed asset.
    let aiSketchUrl = null;
    let aiSketchError = null;
    const aiResult = await generateAiSketch(note, slug);
    if (aiResult.ok) {
      aiSketchUrl = aiResult.url;
    } else {
      aiSketchError = aiResult.error;
    }

    // 4. Commit the markdown note onto the same branch, matching the
    //    site's existing content-collection frontmatter schema. weather/
    //    habitat are full sentences, not keywords -- they don't belong in
    //    tags (whatever the site does with that array clearly wasn't built
    //    for long freeform text, e.g. joining with no separator). They're
    //    rendered instead as labeled lines in the body, same shape as the
    //    on-device journal detail view. Images are embedded in the body as
    //    Cloudinary delivery URLs with f_auto,q_auto baked in, so the CDN
    //    serves the best format and quality per browser without the site
    //    having to transform anything at build time.
    const optimized = (url) => withTransformation(url, "f_auto,q_auto");

    const bodyLines = [
      note || "",
      "",
      locality ? `**Locality:** ${locality}` : null,
      weather ? `**Weather:** ${weather}` : null,
      habitat ? `**Habitat:** ${habitat}` : null,
      photoUrl ? `\n![photo](${optimized(photoUrl)})` : null,
      sketchUrl ? `\n![sketch](${optimized(sketchUrl)})` : null,
      aiSketchUrl ? `\n![AI sketch](${optimized(aiSketchUrl)})` : null,
    ].filter((line) => line !== null);

    const frontmatter = [
      "---",
      `title: "${catalog_no} field observation"`,
      `date: ${timestamp.slice(0, 10)}`,
      `location: "${locality || "Unknown"}"`,
      `excerpt: "${(note || "").slice(0, 140).replace(/"/g, '\\"')}"`,
      photoUrl
        ? `image: "${optimized(photoUrl)}"`
        : aiSketchUrl
          ? `image: "${optimized(aiSketchUrl)}"`
          : null,
      `tags: ["field-note", "community-submission"]`,
      "---",
      "",
      ...bodyLines,
    ].filter((line) => line !== null).join("\n");

    await upsertFile(octokit, {
      branch: branchName, path: `src/content/notes/${slug}.md`,
      message: `Sync entry ${catalog_no}`,
      content: Buffer.from(frontmatter).toString("base64"),
    });

    // 5. Open a PR -- nothing goes live on the site until this is merged.
    // This is the actual safety mechanism now that the endpoint has no
    // auth check: review happens on GitHub, not at submission time.
    const { data: pr } = await octokit.pulls.create({
      owner: OWNER, repo: REPO,
      title: `New field note: ${catalog_no}`,
      head: branchName,
      base: BASE_BRANCH,
      body: [
        "Submitted automatically from a Bloom device.",
        "",
        `**Locality:** ${locality || "\u2014"}`,
        `**Weather:** ${weather || "\u2014"}`,
        `**Habitat:** ${habitat || "\u2014"}`,
        aiSketchUrl ? "\n_AI-generated sketch included._" : null,
      ].filter((line) => line !== null).join("\n"),
      labels: ["device-submission"],
    }).catch(async (err) => {
      // labels: [...] on create() fails on some GitHub API versions if
      // the label doesn't exist yet in the repo -- fall back to a plain
      // PR without it rather than losing the whole submission over a
      // missing label.
      const { data: fallbackPr } = await octokit.pulls.create({
        owner: OWNER, repo: REPO,
        title: `New field note: ${catalog_no}`,
        head: branchName,
        base: BASE_BRANCH,
        body: [
          "Submitted automatically from a Bloom device.",
          "",
          `**Locality:** ${locality || "\u2014"}`,
          `**Weather:** ${weather || "\u2014"}`,
          `**Habitat:** ${habitat || "\u2014"}`,
          aiSketchUrl ? "\n_AI-generated sketch included._" : null,
        ].filter((line) => line !== null).join("\n"),
      });
      return { data: fallbackPr };
    });

    return {
      statusCode: 201,
      body: JSON.stringify({
        success: true, catalog_no, pr_url: pr.html_url,
        ai_sketch: !!aiSketchUrl,
        ...(aiSketchError ? { ai_sketch_error: aiSketchError } : {}),
        ...(photoError ? { photo_error: photoError } : {}),
        ...(sketchError ? { sketch_error: sketchError } : {}),
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 502,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};