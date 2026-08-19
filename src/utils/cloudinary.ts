// Shared helpers for delivering images from Cloudinary.
//
// All field-note media (photos, hand-drawn sketches, AI sketches) is stored
// in Cloudinary and delivered through its CDN. Delivery URLs look like:
//
//   https://res.cloudinary.com/<cloud>/image/upload/v1234/field-notes/<slug>.jpg
//
// A transformation can be inserted as a single extra path segment before the
// version segment. Because that segment never contains a slash and versions
// always match "/v<digits>/", targeting "the segment before the version" is
// unambiguous whether the URL already carries a transformation or not.

const RES_CLOUDINARY = 'res.cloudinary.com';
const VERSION_SEGMENT = /(\/image\/upload\/)(?:[^/]+\/)?(v\d+\/)/;

/**
 * Returns the given Cloudinary delivery URL with a transformation inserted,
 * or the original URL unchanged if it isn't a Cloudinary delivery URL.
 *
 * @param url           A Cloudinary secure_url, e.g.
 *                      "https://res.cloudinary.com/x/image/upload/v123/fp/a.jpg"
 * @param transformation The transformation segment(s), e.g. "f_auto,q_auto" or
 *                      "c_fill,g_auto,w_680,h_400/f_auto,q_auto".
 */
export function cldUrl(url: string, transformation: string): string {
  if (!url.includes(RES_CLOUDINARY)) return url;
  return url.replace(VERSION_SEGMENT, `$1${transformation}/$2`);
}

/**
 * Builds the card-image URL used on the journal index: a fixed 680x400 crop
 * with automatic gravity, plus automatic format and quality selection.
 */
export function cldCardUrl(url: string): string {
  return cldUrl(url, 'c_fill,g_auto,w_680,h_400/f_auto,q_auto');
}