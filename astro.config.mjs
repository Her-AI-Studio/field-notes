// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  redirects: {
    // The behind-the-scenes build log moved into the About page. Keep old
    // URLs to it working (e.g. from earlier journal cards or bookmarks).
    '/notes/behind-the-scenes-ai-sketch-generation': '/about',
  },
});
