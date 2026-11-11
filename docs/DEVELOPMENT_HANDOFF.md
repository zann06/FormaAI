# FormaAI — Development Handoff Package

> **Historical document.** This is the original specification package that the
> implementation started from. It is kept for provenance. For the actual product
> documentation, see [`../README.md`](../README.md).


This package contains the final product specification and coding-agent instructions for FormaAI.

## Files
- `docs/PRD.md` — consolidated product requirements and acceptance criteria.
- `MASTER_PROMPT.md` — instructions to give your coding agent (OpenCode, Claude Code, Kiro, Cursor, etc.).

## How to use
1. Create a new public GitHub repository named `formaai` (or your chosen name).
2. Extract this package into the repository root.
3. Keep `MASTER_PROMPT.md` and `docs/PRD.md` in the repository.
4. Open the repository in your coding agent.
5. Paste the full contents of `MASTER_PROMPT.md` as the initial task.
6. Tell the agent to read `docs/PRD.md` before implementation.
7. Require it to start with Phase 0 (repository inspection and architecture), then proceed phase by phase.
8. Review the implementation and test reports after each phase. Do not accept claims of production readiness without evidence from the acceptance tests.

## Product decisions already established
- Open source, public GitHub repository.
- BYOK: each user supplies their own AI credentials.
- Multi-provider, including custom OpenAI-compatible Base URL and Model ID.
- Multi-user with strict data isolation.
- Hosted SaaS and self-hosted deployment.
- DOCX template is the primary template format.
- PDF, DOCX, and TXT are the initial source formats.
- Editable DOCX and PDF are the target outputs.
- User review is required before final export.

## Important notes
- This is a development specification package, not a completed application.
- The coding agent must verify dependencies, provider compatibility, security, and deployment behavior.
- No provider should be advertised as supported until its adapter has been implemented and tested.
- AGPL-3.0 is a proposed license choice, not legal advice. Confirm the final license and third-party dependency obligations before publication.
- Do not commit API keys, `.env` files, real user documents, or production data.
