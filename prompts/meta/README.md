# Meta-prompts — one set of role rules, rendered per role

[fleet/](../fleet/) states a fleet's rules as prose to read. These are the rules
a role runs by, as templates: one per kind of role, shared fragments, and
everything that belongs to one role — its name, project, directory, track goal
and facts, the owner's decisions — passed in as variables. Each role gets its
rules as a rendered file it reads. Nothing is copied by hand, so a rule changed
here reaches every role on its next render.

| Template | For |
|---|---|
| [worker.md](worker.md) | a worker: takes one dispatch per turn, reports, never hands out work |
| [head.md](head.md) | a project's head: dispatches to workers, accepts by artifact, keeps the track card |
| [orchestrator.md](orchestrator.md) | the orchestrator over the heads: places work, reviews, reflects over the fleet |

[fragments/](fragments/): `turn`, `boundaries`, `preempt`, `privacy`, `report`,
`reflect` (every role), `head-cycle` (heads), `orch-reflect` (the orchestrator).

## Render

    hub prompts render worker --vars vars.json                 # to stdout
    hub prompts render worker --vars vars.json --out rules.md
    hub prompts render worker --vars vars.json --check rules.md

`--vars` is a JSON object, inline (when it starts with `{`) or in a file.
`--check` exits 1 when the file differs from the render, with the differing
lines on stderr. A broken template or a missing variable exits 2 and writes
nothing, so a loop can tell stale rules from a render that cannot happen.

The MCP server serves the same render. `prompts/list` names each template with
its variables as required arguments, described from the tables in this file;
`prompts/get` with all of them returns exactly what `hub prompts render`
prints. A missing or blank argument is an invalid-params error naming it. A
client with no rules file gets the rules of the installed hubd, not a copy.

## Format

- The first line of a template declares every variable it and its fragments
  use: `<!-- vars: role, project, cwd -->`. A comment that starts a line, in a
  template or a fragment, is a note for authors and is not rendered.
- `{{name}}` becomes the variable's value as given: leading and trailing blank
  lines and trailing spaces are trimmed, nothing inside it is expanded.
- `{{> name}}` becomes `fragments/name.md` without its trailing newline, so an
  include can stand on a line of its own. A fragment may include fragments, at
  most 3 deep; a cycle is an error that names the chain.
- Every declared variable is required. A missing or blank one is an error
  naming each of them: a blank in a role's rules drops a fact, and the role
  cannot know it was ever there. A variable used but not declared, or declared
  but never used, is an error too. Variables passed but not declared by the
  template are ignored, so one set of variables renders every template.

## Variables

| Variable | What the role reads there |
|---|---|
| `role` | its own name, the one it reports under |
| `kind` | its kind, as the registry has it |
| `project` | the project it works on |
| `cwd` | its working directory |
| `head` | whom it answers to: a worker's head, a head's orchestrator; for the orchestrator, where escalations leave the fleet (the owner) |
| `allowed_paths` | the paths it may write to, a markdown list indented by two spaces (it sits inside a list item) |
| `track_goal` | the goal of its track |
| `track_facts` | the track's facts, markdown, headings at level 3 or below |
| `owner_decisions` | the owner's decisions so far, a markdown list |
| `base_ref` | the ref its diffs are taken against, e.g. `origin/main` |
| `private_patterns` | what must never reach public git, described: the patterns `private_check` looks for |
| `private_check` | the command it runs before handing a branch over (for review, as a bundle or a patch): it checks the commit messages and the lines the diff against `base_ref` adds, and prints nothing when they are clean |
| `plan_file` | heads: where new tasks are cut from |
| `verdict_cmd` | heads: the command that records an acceptance verdict |

## Changing a rule

Edit the fragment, not a rendered file: a hand edit is overwritten by the next
render, and `--check` reports it until then. A prohibition comes with the check
that fails when it is broken, or it is marked as a wish (see `orch-reflect`): a
note `<!-- wish: <the rule>; no check -->` on the line after it. The mark is for
authors, so the role never reads it, and `grep -rn '^<!-- wish' prompts/meta`
lists the rules nothing checks yet.
