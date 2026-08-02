const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = "Her-AI-Studio";
const REPO = "field-notes";
const BASE_BRANCH = "main";

exports.handler = async (event) => {
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
      await octokit.repos.createOrUpdateFileContents({
        owner: OWNER, repo: REPO, branch: branchName, path: imagePath,
        message: `Add photo for ${catalog_no}`,
        content: photo, // already base64 from the device
      });
    }

    // 3. Commit the sketch onto that branch, if present
    let sketchPath = null;
    if (sketch) {
      sketchPath = `public/images/${slug}-sketch.png`;
      await octokit.repos.createOrUpdateFileContents({
        owner: OWNER, repo: REPO, branch: branchName, path: sketchPath,
        message: `Add sketch for ${catalog_no}`,
        content: sketch,
      });
    }

    // 4. Commit the markdown note onto the same branch, matching the
    // site's existing content-collection frontmatter schema.
    const frontmatter = [
      "---",
      `title: "${catalog_no} field observation"`,
      `date: ${timestamp.slice(0, 10)}`,
      `location: "${locality || "Unknown"}"`,
      `excerpt: "${(note || "").slice(0, 140).replace(/"/g, '\\"')}"`,
      imagePath ? `image: "/${imagePath.replace("public/", "")}"` : null,
      `tags: ["${weather || "field"}", "${habitat || "observation"}"]`,
      "---",
      "",
      note || "",
      sketchPath ? `\n![sketch](/${sketchPath.replace("public/", "")})` : null,
    ].filter(Boolean).join("\n");

    await octokit.repos.createOrUpdateFileContents({
      owner: OWNER, repo: REPO, branch: branchName,
      path: `src/content/notes/${slug}.md`,
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