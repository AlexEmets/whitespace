# Rules for working in this repository

## Commits

- **Never add `Co-Authored-By: Claude …` or any other Claude/AI attribution** to commit
  messages or pull request descriptions. Plain conventional-commit messages only
  (`feat(web): …`, `fix(contracts): …`, `test(liquidator): …`, `docs: …`).
- One commit per logical change. Do not batch unrelated changes.

## Tests

- Every behaviour change ships with tests that cover all of its cases, including failure
  and boundary paths. Coverage is not optional here.
- A new test must fail against the code without the fix. A test that is green either way
  proves nothing.
