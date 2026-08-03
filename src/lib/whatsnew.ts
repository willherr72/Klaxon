/// Pull one version's section out of CHANGELOG.md (Keep-a-Changelog
/// shape): everything from "## [x.y.z]" to the next "## [" heading.
/// Returns the body without the heading line, trimmed, or null when the
/// version has no section (dev builds between releases, parse drift).
export function extractChangelogSection(
  changelog: string,
  version: string,
): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body.length ? body : null;
}
