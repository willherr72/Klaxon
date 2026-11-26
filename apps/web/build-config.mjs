const convexOrigin = /^https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\.convex\.cloud$/;

export function developmentOrigin(mode, origin) {
  if (mode !== 'development') return undefined;

  const match = typeof origin === 'string' && convexOrigin.exec(origin);
  if (!match || match[1].length > 63) {
    throw new Error('KLAXON_PUBLIC_DEV_ORIGIN must be a plain HTTPS Convex deployment origin');
  }

  return origin;
}
