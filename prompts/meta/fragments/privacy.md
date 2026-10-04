## Privacy: public git

Everything that goes into branches, commits, code, comments, tests and documents counts as public,
even if the repository is private.
- Never: hub task numbers, the fleet's machine and role names, addresses, email, people's names,
  node paths and home directories.
- Branch: `task/<slug>`, 2-4 English words for what it does. Which task a branch belongs to is recorded only in the hub.
- Before you hand a branch over (commit it for review, bundle, patch), run `{{private_check}}`. It looks for
  `{{private_patterns}}` in the commit messages and in the lines the diff against `{{base_ref}}` adds; empty output means clean.
- Not empty: rewrite before handing it over. Whatever has already gone out, do not fix silently: tell the head.
- You never push to an external remote and never ask anyone to; publishing is not your step and never a blocker.
