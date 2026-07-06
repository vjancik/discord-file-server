<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Environment
Use bun instead of node & npm. Use it for building and running next.js standalone build as well.
When using any bun command prepend it with `bunx cross-env AGENT=1` (for example: `bunx cross-env AGENT=1 bun run test`)
After implementing your task, run `bun run typecheck && bun run codecheck:fix` and fix any errors until it passes all checks

## Coding Rules
Write modular, testable code that favors DI coding patterns (e.g. DDD, Hexagonal architecture, SOLID) without introducing unnecessary complexity to frontend code.
Use a centralized logger.
Write unit tests for non trivial business logic and data transformation.
Write integration tests for major modules and repositories. 
Write component tests and e2e tests after major parts of the UI are implemented.
Use mock data, mocking & testing capabilities of major cross cutting libraries (like Better Auth).