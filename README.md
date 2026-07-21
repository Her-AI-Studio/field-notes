# Field Notes

A digital field journal — a collection of natural history observations, surveys, and records from the field.

Built with [Astro](https://astro.build) and Markdown content collections.

## Project Structure

```text
/
├── public/
│   └── favicon.svg
├── src/
│   ├── content/
│   │   ├── config.ts
│   │   └── notes/
│   │       ├── observation-of-the-red-shouldered-hawk.md
│   │       ├── botanical-survey-of-coastal-dune-ecology.md
│   │       ├── geological-observations-along-the-appalachian-trail.md
│   │       └── nocturnal-insect-survey-june.md
│   ├── layouts/
│   │   └── Layout.astro
│   ├── pages/
│   │   ├── index.astro
│   │   └── notes/
│   │       └── [...slug].astro
│   └── styles/
│       └── global.css
└── package.json
```

## Adding a New Note

Create a new `.md` file in `src/content/notes/` with frontmatter:

```yaml
---
title: "Your Note Title"
date: 2026-07-21
location: "Location, State"
excerpt: "A brief summary of the observation."
image: "/images/your-image.jpg"
tags: ["tag1", "tag2"]
---
```

The note will automatically appear on the index page and be accessible at `/notes/[filename]/`.

## Commands

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build production site to `./dist/`               |
| `npm run preview`         | Preview build locally before deploying           |