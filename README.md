# veridelta

**A verification delta protocol for coding agents.**

Given two comparable test runs, veridelta reports — deterministically and with
evidence — whether a change improved the outcome *while keeping the same
verification surface*, whether pre-existing failures mutated into different
failures, and whether red results disappeared because they were fixed or
because the verification surface shrank (fail→skip, deleted tests, narrowed
selectors). When the runs are not comparable, it abstains instead of guessing.

- **Protocol spec:** [`spec/veridelta-1.md`](spec/veridelta-1.md) — the
  `veridelta/1` schema, trust invariants, gate semantics, and conformance
  requirements. The spec is the product; independent implementations are the
  intended success mode.
- **Reference implementation:** `vdelta` (CLI) — in development.

## Status

Draft. The spec (`veridelta/1`, revision 0.1.0) precedes the implementation;
a validation spike of the reference CLI is planned next.

## License

MIT — see [LICENSE](LICENSE).
