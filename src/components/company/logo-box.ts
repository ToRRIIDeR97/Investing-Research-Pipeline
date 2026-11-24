// Logo sizing for CompanyLogo, kept apart from the component so it can be tested without React or CSS.

/**
 * Logo box inside a `size` square, normalized by shape so every logo covers about the same area: a square mark (Apple)
 * gets about 70% of the square, a wide wordmark (SoFi) runs nearly full width but short. Pure.
 */
export function logoBox(size: number, ratio: number): { width: number; height: number } {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const side = size * 0.7; // the side of a square logo; every logo gets this area
  let width = side * Math.sqrt(r), height = side / Math.sqrt(r);
  const fit = Math.min(1, size / width, size / height);
  width *= fit; height *= fit;
  return { width: Math.round(width), height: Math.round(height) };
}
