## Communication

- Always talk in ASD-STE100 Simplified Technical English. Applies to documentation and comments as well.

## Specification

- Read `SPECS.md` before starting work. It defines required behavior and architecture, including implemented features and work still to do.
- Check the implementation against the relevant requirements before making changes and before reporting completion. Do not assume a feature exists because the spec describes it.
- Do not change the spec to justify the implementation. Keep the spec and implementation consistent.
- Stay within the requested scope.
- When the spec is silent, allows more than one reading, or asks for something a platform cannot do, choose the behavior that best keeps the intent of the spec with the least new code and configuration. For a platform limit, use the closest behavior that keeps the requirement's intent and the fallback rules of `SPECS.md`, and write the limit in `README.md`.
- Keep configuration minimal. Add only the configuration options that `SPECS.md` describes, with the names, accepted values, and defaults it gives. Add an option beyond the spec only when the implementation cannot work without it, and put a comment next to its definition in the configuration file that states why it is necessary. Use the simplest configuration format that can hold the settings; prefer environment variables.

## Design

Apply to every non-trivial change. These constrain design, not formatting.

- **Single Responsibility** — one reason to change per module. Split modules and functions that mix unrelated responsibilities, e.g. business rules with IO, formatting, or framework glue. Things that change together live together; things that change for different reasons live apart. "A new variant exists" is a reason to change like any other, and it belongs to the variant alone: a module edited every time a variant is added has taken on a responsibility that is not its own. Everything that changes when one variant changes lives with that variant — its name, its own settings parsing, its registration.
- **Open/Closed** — extend by adding implementations, not by editing code that enumerates cases. Apply only where variation already exists or is concretely requested; do not pre-build plugin points for imagined futures. Where a variation point does exist, a new variant is a purely additive change, and nothing that already works is edited to accommodate it. Where the language cannot link a variant nothing references, the single permitted reference is a declaration of intent — an import, a manifest entry — with no logic in it to review.
- **Liskov Substitution** — an implementation must be usable wherever its abstraction is expected: no strengthened preconditions, no weakened postconditions, no not-supported members, no caller type-checking the abstraction.
- **Interface Segregation** — narrow, client-specific interfaces. Clients must not depend on members they don't call.
- **Missing capability belongs to the abstraction** — when an implementation needs something the abstraction does not offer, add it to the abstraction so every implementation has it and the caller drives it. Do not satisfy the need privately inside one implementation: the next implementation has the same need and no reason to solve it the same way, and the two are now impossible to drive together.
- **Lifecycle belongs to the owner of the process** — startup, shutdown, signals, and cleanup are decided once by the code that assembles the system, and reach an implementation through the abstraction. An implementation that watches signals or ends the process on its own has taken a responsibility that is not its own.
- **Dependency Inversion** — high-level policy must not depend on low-level detail. Source dependencies point from IO-near code (UI, HTTP, filesystem, database, SDKs, clock, randomness, env) inward toward IO-far policy, and the abstraction is owned by the high-level side. This governs the set of implementations as well as their behavior: the abstraction owns the registry variants enter and answers what is available, so policy asks it what exists rather than naming variants itself, and the dependency runs from variant to abstraction only. A module that assembles the system may reference a variant in order to link it, never in order to know it. Self-announcement trades discoverability and startup-time error reporting for additivity; a central enumeration is a deliberate exception, taken when the set of variants is closed, and stated as such.

## Writing Code

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- When the correct change lies in a shared abstraction, change the abstraction. Do not build a local workaround that avoids touching it. A workaround that keeps the seam untouched is more expensive than the change it avoided, because it hides the need and every later implementation repeats it.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection. Omit steps that aren't needed: do not compute, read, or store values that nothing depends on. Prefer simple, correct approaches over premature optimization when the input is small.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Before writing code by hand, check whether a language built-in, the standard library, an installed dependency, or a well-maintained package already does it. Read its docs and types instead of assuming what it cannot do.
- Adding a dependency to delete boilerplate is a good trade, even when the hand-written version would only be a few lines. Small amounts of custom code still have to be read, tested, and maintained; a library that is already solving this problem for others does not.
- For each external integration, use its official SDK or its most widely used maintained library.
- Question whether a new type, wrapper, or class is needed at all. If the same behavior is expressible with a plain value, an existing type, or a function, do that instead. Introduce a struct only when it removes real ceremony rather than adding it.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Work in small, reviewable increments. Do not mix behavior change with refactoring in the same step.
- Names state intent. Rename when a better name clarifies a responsibility.
- Keep comments minimal. Code should be self-explanatory. Comment only to explain why, not what. If code needs a comment to be understood, rewrite it to be clearer instead. Aim for the smallest changeset that solves the problem.
- Repeating text is not the problem DRY solves. Before finishing a change, look for the same decision written in more than one place and unify it: if changing it in one place and not the other would be a bug, it belongs in one place. Code that merely looks alike, but changes for different reasons, stays separate.
- Do not name a constant for a value used in one place. A literal at its one call site is clearer than a name defined elsewhere. Introduce the constant on the second use, or when the name explains something the value cannot.
- Keep functions small enough to hold in one's head and files small enough to review in one sitting. When a function accumulates branches or a file outgrows a review-sized unit, split along responsibility lines, not by line count.
- Do not export symbols that are only used internally.
- Let the language's type inference do the work where it can. Omit explicit type annotations when inference yields the same type.
- Do not leak persistence shapes, DTOs, framework types, or transport formats across a boundary. Convert at the boundary.
- Keep persistent state minimal. Store data only in the files and folders that `SPECS.md` names, and keep each fact in one place. Derive state from the stored record instead of storing it again in another file. Add a file only when the implementation cannot work without it, and put a comment where the file is defined that states why it is necessary.
- Adding a variant must not touch a config schema, a route table, a shared switch, or a validation list. If it does, the seam is in the wrong place. Before calling the work done, name what an unrelated variant would have to edit.
- Keep IO-near adapters as thin shells with no decision logic, so core behavior is testable without UI, network, filesystem, or devices.
- Modules expose only what callers need. Representation, IO details, and invariant enforcement stay hidden.
- Do not create import cycles.

## Testing

The project has two levels of tests. Both run in `bun check`.

### Unit tests

- Purpose: fast feedback that each module compiles, runs, and does what its code intends.
- Put them next to the code as `*.test.ts`. Test one module through its exported functions.
- Keep them fast and isolated.

### End-to-end tests

- Purpose: prove that the requirements in `SPECS.md` are implemented correctly, including their edge cases and the acceptance journeys.
- Put them in the top-level `e2e/` folder. Name each test after the requirement it checks and its `SPECS.md` section.
- Treat the application as a black box. Start it as a process with environment variables and a temporary data folder. Use only its external interfaces: HTTP routes, the data folder, and the network calls it makes. Do not import its modules.
- Replace each external service (channel platforms, model gateway, MCP servers) with a fake HTTP server that the test controls. A fake records the calls it receives, so the test can check what the application sent.
- Every requirement and edge case in `SPECS.md` has at least one end-to-end test. When a requirement changes, change its test in the same step.

### Rules for both levels

- Write the test first for the observable behavior. It must fail for a plausible wrong implementation. Then write only enough production code to pass it.
- Tests state expected values as literals. A test that compares against the production constant passes even when the value is wrong.
- Never make a test pass by weakening its assertion.

## Structure

- Treat the current file and directory layout as a proposal, not a given. When a change makes the existing structure awkward, change the structure instead of forcing the change into the wrong place.

## Verification

Nothing is done until it has been reviewed and checked. Review first, then run the checks.

### Review passes

Before you open a pull request, review the whole change in three passes, in this order. Fix what a pass finds before you start the next pass.

1. **Simplification.** Remove code, files, configuration, and state that the requirements do not need. Unify decisions that are written in more than one place. Replace custom code with built-ins or installed libraries. Make names and structure clear. This pass does not change behavior.
2. **Performance.** Find work that grows without need: repeated reads or parses of a whole record, calls in sequence that can run at the same time, concurrency without a limit, network calls without a timeout, and timers that keep the process alive. Fix only problems that occur at a realistic load. Do not add caches, indirection, or other complexity for loads that do not occur, and do not optimize code that is fast enough.
3. **Security.** Check every trust boundary: authentication of incoming requests, validation of external input, file paths built from external values, the scope of tool permissions, and secrets or personal data in logs, errors, and customer messages. When a permission cannot be enforced, refuse it.

### Run the checks

Before you report work done, and before each commit, run `bun check`.
