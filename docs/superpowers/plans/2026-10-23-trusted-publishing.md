# Trusted publishing implementation

Spec: ../specs/2026-10-23-trusted-publishing-design.md
Execution: inline, test-first slices, independent review before completion.
- [x] Freeze OIDC/provenance policy and validate configuration/CI inputs without dry-run side effects.
- [x] Implement guarded package-scoped OIDC exchange; prove real-core publication, failure and retry behavior.
- [x] Generate and verify Sigstore provenance, retain it with immutable artifacts and submit exact attachments.
- [x] Reconcile registry attestations and test fresh-clone recovery without re-signing or duplicate publishing.
- [x] Document CI setup, run full compatibility/quality/packaging checks, review and commit.


## Verification

- `pnpm check` passed strict types, formatting/lint, build and all 200 tests on Node 24.17.0, including 32 new real semantic-release trusted-publishing integration cases.
- Node 24.0.0 passed the public package import and all 32 trusted-publishing integration cases (33 checks), proving the supported runtime floor.
- Node 26.12.1 passed the other 31 trusted-publishing cases and the final private-identity regression after its fixture correction. Production verification code was unchanged by that fixture correction.
- Integration coverage includes GitHub Actions and GitLab cryptographically verified provenance, CircleCI OIDC, automatic/native policy overrides, package-scoped exchange, registry overrides, zero-side-effect dry/no-change runs, required-identity preflight, token expiry, failed exchanges, same/cross-origin redirects, signature/source mismatch, pinned trust-root drift, attestation corruption/missing/404, and rejected/uncertain-upload fresh-clone recovery.
- Signatures, certificate transparency, log inclusion and signed TUF trust metadata are verified using official Sigstore cryptographic fixtures over local HTTP services. No public registry uploads or public signing ledger writes occur in tests.
- Independent read-only review approved after fixes for legacy authentication policy preservation, scoped-package visibility, exchange redirect rejection, attestation-404 reconciliation, pure identity validation and strict retained statement boundaries.
- Test workers are bounded to two: unrestricted parallel integration files caused two pre-existing 60-second scenarios to time out under process contention; the bounded complete suite passed.
- Frozen installation, package inspection (five expected files and byte-identical tested bundle), and diff whitespace checks passed. Runtime audit adds no new advisory; the documented unpatched upstream braces issue remains. Existing TypeScript-API build and Node 24.0 glob warnings remain.
