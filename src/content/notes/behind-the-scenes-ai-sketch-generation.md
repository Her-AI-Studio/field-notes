---
title: "How this journal sketches itself"
date: 2026-08-04
location: "the Netlify function, not the field"
excerpt: "A look at sync-entry.js — the serverless function that turns a device submission into a pull request, and how it asks Cloudinary to draw a matching field sketch for every entry."
image: "https://res.cloudinary.com/uq7m2iiz/image/upload/f_auto,q_auto/v1787169844/field-notes/sync-entry-reference.jpg"
tags: ["build-log", "cloudinary", "ai-sketch"]
---

Most entries in this journal describe something seen outdoors. This one describes something that happens right after: the moment a submission from a Bloom device becomes a page on this site.

That handoff is a single Netlify function, `netlify/functions/sync-entry.js`, and it does three things — commit whatever media came in, ask Cloudinary to generate a sketch to match, and open a pull request so nothing publishes without a human looking at it first.

## From device to pull request

A submission arrives as JSON: a catalog number, a timestamp, a note, and optionally a photo and a hand-drawn sketch, both already base64-encoded on the device. The function:

1. Branches off `main` — `entry/<slug>-<timestamp>` — so every submission is isolated.
2. Uploads the photo and sketch, if present, to Cloudinary (`field-notes/<slug>` and `field-notes/<slug>-sketch`) so the site can deliver them through Cloudinary's CDN with automatic format and quality optimization.
3. Asks Cloudinary to generate an AI field sketch (below).
4. Writes the markdown file into `src/content/notes/`, referencing all three images as Cloudinary delivery URLs. Only the markdown is committed to the repo — image binaries live in Cloudinary.
5. Opens a PR against `main`, labeled `device-submission`.

That last step is the actual safety mechanism. The endpoint itself checks nothing beyond size and required fields — no auth, because a field device shouldn't need to manage credentials. Review happens on GitHub, not at submission time.

## Generating a sketch with a reference image

Every entry gets an AI-generated sketch, whether or not the observer submitted a photo or drew one by hand. The prompt is built from the note text:

> "Create a field sketch illustration in the style of the reference image [1]. The sketch should depict: *(the note)*. Use a vintage field journal aesthetic with earthy tones, hand-drawn quality, and scientific illustration style."

The `[1]` isn't decorative — it points at a `reference_images` array passed to Cloudinary's `image_to_image` generation endpoint, pinned to one fixed image (pictured above) that acts as a style guide. Every generated sketch is steered toward that same look, so the AI sketches across dozens of entries — different handwriting, different species, different observers — still read as one consistent visual voice rather than a new style each time.

The request that goes to Cloudinary:

```js
fetch(`https://api.cloudinary.com/v2/generate/${cloudName}/image_to_image`, {
  method: "POST",
  headers: { Authorization: `Basic ${credentials}` },
  body: JSON.stringify({
    prompt,
    reference_images: [{ source_type: "url", url: REFERENCE_IMAGE_URL }],
    model: { family: "nano-banana", tier: "premium" },
    target: { target_type: "managed_asset", public_id: `field-notes/${slug}-ai` },
  }),
});
```

The response points at the generated asset, which Cloudinary already stores as a managed asset — the function's markdown references its delivery URL (with `f_auto,q_auto`) rather than downloading a copy into the repo. If generation fails — missing credentials, a bad response, a network hiccup — the function doesn't fail the whole submission. It logs the reason, skips the AI sketch, and lets the PR go through with whatever media *did* arrive.

## Why bother

A device in the field can capture a photo or a rough sketch, but not always both, and not always well. The AI sketch is a third, more consistent artifact — something that gives every entry, however partial, the same hand-drawn field-journal feel this site is trying to have throughout.
