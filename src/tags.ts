/**
 * What a release is called: its tag, the label used in commit messages, and
 * the GitHub release title.
 *
 * The default prefix is `v`, which gives the `v1.2.3` tags this script has
 * always made. A package in a repository that releases more than one package
 * sets a prefix of its own, conventionally `<name>@`, so each package gets its
 * own series of tags — `server@18.19.0`, `worker@21.24.0` — instead of every
 * package fighting over one shared `vX.Y.Z`.
 */
export const DEFAULT_TAG_PREFIX = 'v';

export interface ReleaseName {
  /** The git tag, and the tag the GitHub release is attached to. */
  tag: string;
  /**
   * How commit messages refer to the release. A bare version with the
   * default prefix, as it always was; the full tag otherwise, since `18.19.0`
   * alone does not say which package it was in a repository with several.
   */
  label: string;
  /** The GitHub release title: `v1.2.3`, or `server 18.19.0` for `server@`. */
  title: string;
}

export function releaseName(prefix: string, version: string): ReleaseName {
  const tag = `${prefix}${version}`;
  if (prefix === DEFAULT_TAG_PREFIX) {
    return { tag, label: version, title: tag };
  }
  const title = prefix.endsWith('@') ? `${prefix.slice(0, -1)} ${version}` : tag;
  return { tag, label: tag, title };
}
