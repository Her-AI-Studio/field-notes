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

// Cloudinary Image Generation API configuration.
// The reference image (ai-field-notes_zqownu.jpg) is used as a style guide
// for AI-generated field note sketches, keeping the visual aesthetic
// consistent across all generated images.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const REFERENCE_IMAGE_URL = "https://res.cloudinary.com/jen-demos/image/upload/v1785719484/ai-field-notes_zqownu.jpg";

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
// Returns { ok: true, base64 } on success, or { ok: false, error } carrying
// the reason so callers can surface why generation failed instead of
// silently omitting the image.
async function generateAiSketch(noteText, slug) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
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

    // Download the generated image and return it as base64 for committing to the repo
    const imageResponse = await fetch(asset.storage.secure_url);
    if (!imageResponse.ok) {
      console.error(`Failed to download generated image (${imageResponse.status})`);
      return { ok: false, error: `Failed to download generated image (${imageResponse.status})` };
    }
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    return { ok: true, base64: imageBuffer.toString("base64") };
  } catch (err) {
    console.error("Cloudinary image generation error:", err.message);
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

    // 2. Commit the photo onto that branch, if present
    let imagePath = null;
    if (photo) {
      imagePath = `public/images/${slug}.jpg`;
      await upsertFile(octokit, {
        branch: branchName, path: imagePath,
        message: `Add photo for ${catalog_no}`,
        content: photo, // already base64 from the device
      });
    }

    // 3. Commit the sketch onto that branch, if present
    let sketchPath = null;
    if (sketch) {
      sketchPath = `public/images/${slug}-sketch.png`;
      await upsertFile(octokit, {
        branch: branchName, path: sketchPath,
        message: `Add sketch for ${catalog_no}`,
        content: sketch,
      });
    }

    // 3b. Generate an AI field note sketch using Cloudinary's Image
    // Generation API with the reference image, whether or not a photo
    // was also provided.
    let aiSketchPath = null;
    let aiSketchError = null;
    const aiResult = await generateAiSketch(note, slug);
    if (aiResult.ok) {
      aiSketchPath = `public/images/${slug}-ai.png`;
      await upsertFile(octokit, {
        branch: branchName, path: aiSketchPath,
        message: `Add AI-generated sketch for ${catalog_no}`,
        content: aiResult.base64,
      });
    } else {
      aiSketchError = aiResult.error;
    }

    // 4. Commit the markdown note onto the same branch, matching the
    // site's existing content-collection frontmatter schema. weather/
    // habitat are full sentences, not keywords -- they don't belong in
    // tags (whatever the site does with that array clearly wasn't built
    // for long freeform text, e.g. joining with no separator). They're
    // rendered instead as labeled lines in the body, same shape as the
    // on-device journal detail view. The photo is embedded directly in
    // the body too, alongside the sketch, rather than relying only on
    // the "image" frontmatter field -- that guarantees it's visible
    // regardless of whether the site's layout uses that field at all.
    const bodyLines = [
      note || "",
      "",
      locality ? `**Locality:** ${locality}` : null,
      weather ? `**Weather:** ${weather}` : null,
      habitat ? `**Habitat:** ${habitat}` : null,
      imagePath ? `\n![photo](/${imagePath.replace("public/", "")})` : null,
      sketchPath ? `\n![sketch](/${sketchPath.replace("public/", "")})` : null,
      aiSketchPath ? `\n![AI sketch](/${aiSketchPath.replace("public/", "")})` : null,
    ].filter((line) => line !== null);

    const frontmatter = [
      "---",
      `title: "${catalog_no} field observation"`,
      `date: ${timestamp.slice(0, 10)}`,
      `location: "${locality || "Unknown"}"`,
      `excerpt: "${(note || "").slice(0, 140).replace(/"/g, '\\"')}"`,
      imagePath
        ? `image: "/${imagePath.replace("public/", "")}"`
        : aiSketchPath
          ? `image: "/${aiSketchPath.replace("public/", "")}"`
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
        aiSketchPath ? "\n_AI-generated sketch included._" : null,
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
          aiSketchPath ? "\n_AI-generated sketch included._" : null,
        ].filter((line) => line !== null).join("\n"),
      });
      return { data: fallbackPr };
    });

    return {
      statusCode: 201,
      body: JSON.stringify({
        success: true, catalog_no, pr_url: pr.html_url,
        ai_sketch: !!aiSketchPath,
        ...(aiSketchError ? { ai_sketch_error: aiSketchError } : {}),
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