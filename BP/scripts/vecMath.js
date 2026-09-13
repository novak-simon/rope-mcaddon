export function distance3D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Returns a point that is `radius` away from `anchor`, in the direction of `point`. */
export function clampToRadius(anchor, point, radius) {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const dz = point.z - anchor.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist === 0) return { x: point.x, y: point.y, z: point.z };
  const scale = radius / dist;
  return {
    x: anchor.x + dx * scale,
    y: anchor.y + dy * scale,
    z: anchor.z + dz * scale,
  };
}

export function lerpVec(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}
