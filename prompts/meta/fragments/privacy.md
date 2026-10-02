## Privacy: public git

Everything that goes into branches, commits, code, comments, tests and documents counts as public,
even if the repository is private.
- Never: hub task numbers, the fleet's machine and role names, addresses, email, people's names,
  node paths and home directories.
- Branch: `task/<slug>`, 2-4 English words for what it does. Which task a branch belongs to is recorded only in the hub.
- Before a push, run the check for the patterns `{{private_patterns}}` over the commit messages and over the lines
  the diff against `{{base_ref}}` adds. Both outputs must be empty.
- Not empty: rewrite before the push. Whatever has already gone out, do not fix silently: tell the head.
- Only whoever the project's rules name pushes outward; you push to a local branch.
