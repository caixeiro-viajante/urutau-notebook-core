# ADR-CURA-001: Isolated documentary adapter for Cura em Movimento

Date: 2026-10-28

Status: Implemented in the Cura fork; Google AI activation awaits the existing credential.

## Context

The owner explicitly requested a fork of Open Notebook and a documentary process outside the main website, using the existing Cloudflare infrastructure and Google AI. Folha text, attachments and existing structured objects must remain attributable and faithful to their sources. The diary already has its own authenticated account, library and immersive reading player.

## Decision

Add a bounded adapter under `cloudflare/`, leaving the upstream Python, Next.js and SurrealDB application intact. Deploy a private Worker with dedicated D1, private R2 and Queue resources. Only the diary's private Service Binding may call it; the gateway derives owner identity from the signed diary session.

Freeze each contribution with its source hashes and original structured objects. Return canonical JSON-LD and a `cura/semantic-delta@1` adapter, with owner-private scope. Trail scope currently identifies an owner's trail contribution; it does not grant shared trail write access. Global scope creates a private proposal for later review.

Google Gemini is a deliberate provider-specific executor requested by this deployment's owner. Provider code is isolated in `src/gemini.ts`; the canonical sources and manifests do not depend on model output. Missing credentials preserve a resumable job. This fork does not alter the upstream provider matrix or claim that the upstream Open Notebook server is running in a Worker.

Model output is advisory, bounded and separate from the source. A quote must occur literally in the frozen text. PDF/image transcription is unreviewed until the participant checks it before creating reading leaves. Images have only one source page. A daily atomic attempt quota and serial queue consumer bound usage; an uncertain dispatched attempt requires explicit retry.

## Consequences and verification

The main site remains a thin authenticated client. Existing writing leaves keep their format; reviewed reading leaves opt into the player through their type. Original files can be opened from existing local media or the authenticated server resolver.

The Worker has 15 passing tests using real SQLite in memory and simulated R2, Queue and provider responses. Worker type checking and dry-run bundling passed. The diary integration has additional tests and was built and checked in the published browser. No paid provider call has been validated while the credential is missing. The unchanged upstream Python/frontend suites were not run for this adapter-only change.

No new hosting plan or public data route is introduced. The upstream history and MIT license remain preserved. This decision is deployment-specific and is not proposed as an upstream product direction change.
