# Cargo trusted publishing

Extend the current publisher with `cargo.trustedPublishing: "auto" | true | false` (auto by default), preserving native Cargo credentials when OIDC is disabled/unavailable and preserving older pending token batches. Once selected, OIDC never falls back after failure. Freeze effective authentication with each destination. Support GitHub Actions identity requests and GitLab.com's `CRATES_IO_ID_TOKEN` (GitLab support is upstream public beta); unsupported providers fail required-mode preflight. No new dependencies.

Follow the crates.io protocol: request a CI identity with audience equal to the registry API base minus its HTTP(S) scheme; POST `{jwt}` to `<api>/api/v1/trusted_publishing/tokens`, read `{token}`, use the token for crate PUTs only, and DELETE that endpoint with Bearer authorization in cleanup. Include a descriptive User-Agent. The registry validates signatures and crate trust settings. Never store credentials in journals, artifact refs, manifests or logs.

A CI JWT can be exchanged only once. A single invocation shares an exchanged token in memory among crates on the same frozen API, without reusing credentials across invocations or origins. Revoke all acquired tokens on success or failure, including uncertain uploads. Registry tokens expire after 30 minutes; stop using the in-memory credential after 25 minutes and require a fresh job. A revocation failure leaves the batch pending and is reported without credentials. Crash recovery relies on upstream expiry and durable package proofs, not persisted tokens.

Dry runs perform pure policy/available-identity checks, without discovery HTTP, identity/exchange/revoke calls, packing or durable writes. Retained accepted uploads can finish without current CI credentials. Rejected uploads reuse immutable crates with newly exchanged credentials. No-change runs have no authentication effects. Read probes and Cargo dependency verification retain ordinary read credentials; publishing OIDC tokens are never exported to Cargo or package scripts.

OIDC identity, registry exchange, upload and revocation reject redirects. Exchange/revocation require HTTPS (loopback HTTP for tests only); the API discovered from sparse config.json is frozen, including named registry overrides. Existing registry read transport and native packing remain intact.

Use real semantic-release, native verified Cargo packaging, disposable Git remotes and local protocol fixtures. Cover coordinated crates/single-use identity, GitHub/GitLab, dry/no-change, credentials, no fallback, malformed/rejected/expired tokens, credential-safe redirects, native mode, frozen policy/API and fresh-clone retry/revocation behavior. No public registry writes.

Primary protocol references:
- https://crates.io/docs/trusted-publishing
- https://github.com/rust-lang/crates.io/blob/main/src/controllers/trustpub/tokens/exchange/mod.rs
- https://github.com/rust-lang/crates.io/blob/main/src/controllers/trustpub/tokens/revoke/mod.rs
- https://github.com/rust-lang/crates-io-auth-action/blob/main/src/registry_url.ts
