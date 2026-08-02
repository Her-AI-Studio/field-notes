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
    ].filter((line) => line !== null);

    const frontmatter = [
      "---",
      `title: "${catalog_no} field observation"`,
      `date: ${timestamp.slice(0, 10)}`,
      `location: "${locality || "Unknown"}"`,
      `excerpt: "${(note || "").slice(0, 140).replace(/"/g, '\\"')}"`,
      imagePath ? `image: "/${imagePath.replace("public/", "")}"` : null,
      `tags: ["field-note"]`,
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
      ].join("\n"),
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
        ].join("\n"),
      });
      return { data: fallbackPr };
    });

    return {
      statusCode: 201,
      body: JSON.stringify({ success: true, catalog_no, pr_url: pr.html_url }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 502,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};