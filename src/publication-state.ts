import { oid } from './plan-validation.js';
import type { Artifact } from './release-io.js';
import { record } from './workspace-files.js';

export interface Destination {
  ecosystem: 'npm' | 'cargo';
  registry: string;
  access?: 'public' | 'restricted' | null;
  tag?: string;
  index?: string;
  api?: string;
  npmAuth?: 'oidc';
  provenance?: true | 'auto';
  sigstore?: {
    fulcioURL: string;
    rekorURL: string;
    tufMirrorURL: string;
    tufRootPath: string;
    tufRootDigest: string;
  };
}
export interface PublicationPackage {
  id: string;
  destination: Destination;
  artifact?: Artifact;
  intent: boolean;
  published: boolean;
  tagged: boolean;
}
export interface Execution {
  prepared: string;
  packages: PublicationPackage[];
}
export function validExecution(value: unknown): value is Execution {
  return (
    record(value) &&
    oid(value.prepared) &&
    Array.isArray(value.packages) &&
    new Set(
      value.packages.map((entry: unknown) => (record(entry) ? entry.id : null)),
    ).size === value.packages.length &&
    value.packages.every((entry: unknown) => {
      if (
        !record(entry) ||
        typeof entry.id !== 'string' ||
        !record(entry.destination) ||
        !['npm', 'cargo'].includes(String(entry.destination.ecosystem)) ||
        typeof entry.destination.registry !== 'string' ||
        !['intent', 'published', 'tagged'].every(
          (key) => typeof entry[key] === 'boolean',
        )
      )
        return false;
      if (
        (entry.destination.npmAuth !== undefined &&
          entry.destination.npmAuth !== 'oidc') ||
        (entry.destination.provenance !== undefined &&
          entry.destination.provenance !== true &&
          entry.destination.provenance !== 'auto')
      )
        return false;
      const sigstore = entry.destination.sigstore;
      if (
        sigstore !== undefined &&
        (!record(sigstore) ||
          ![
            'fulcioURL',
            'rekorURL',
            'tufMirrorURL',
            'tufRootPath',
            'tufRootDigest',
          ].every((key) => typeof sigstore[key] === 'string') ||
          !/^[a-f0-9]{64}$/.test(String(sigstore.tufRootDigest)))
      )
        return false;
      if (
        (entry.tagged && !entry.published) ||
        (entry.published && !entry.intent) ||
        (entry.intent && !entry.artifact)
      )
        return false;
      if (
        entry.artifact !== undefined &&
        (!record(entry.artifact) ||
          !oid(entry.artifact.commit) ||
          typeof entry.artifact.ref !== 'string' ||
          !/^refs\/semantic-release-workspace\/artifacts\/[a-f0-9]+\/[a-f0-9]{64}$/.test(
            entry.artifact.ref,
          ) ||
          typeof entry.artifact.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.artifact.sha256) ||
          typeof entry.artifact.integrity !== 'string' ||
          !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.artifact.integrity))
      )
        return false;
      return true;
    })
  );
}
