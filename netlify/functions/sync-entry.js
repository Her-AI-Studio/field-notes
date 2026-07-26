const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = "Her-AI-Studio";
const REPO = "field-notes";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  const token = event.headers["authorization"];
  if (token !== `Bearer ${process.env.DEVICE_API_TOKEN}`) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const { catalog_no, timestamp, note, locality, weather, habitat, photo, sketch } = JSON.parse(event.body);
  const slug = catalog_no.toLowerCase();

  // 1. Commit the photo, if present
  let imagePath = null;
  if (photo) {
    imagePath = `public/images/${slug}.jpg`;
    await octokit.repos.createOrUpdateFileContents({
      owner: OWNER, repo: REPO, path: imagePath,
      message: `Add photo for ${catalog_no}`,
      content: photo, // already base64 from the device
    });
  }

  // 2. Commit the markdown note, matching the site's existing frontmatter schema
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
  ].filter(Boolean).join("\n");

  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO,
    path: `src/content/notes/${slug}.md`,
    message: `Sync entry ${catalog_no}`,
    content: Buffer.from(frontmatter).toString("base64"),
  });

  return { statusCode: 201, body: JSON.stringify({ success: true, catalog_no }) };
};