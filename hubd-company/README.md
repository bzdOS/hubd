# hubd-company — your AI company in a folder

A template for running a team of AI agents and people on one product: the company's
rules, a role per job, and procedures any agent can run. Built on
[hubd](https://github.com/bzdOS/hubd): the folder is the team's hub, and everything in
it is a plain file you can read, grep and `git diff`.

**Hiring an agent here is a fresh session that reads a role file.** That is how this
template's authors hired their own CTO.

## What you get

```
AGENTS.md        the company's rules: org, delivery chain, channels, escalations
roles/           one file per role: paste it into a fresh session to hire
  team.json        the org as data: each role's rank, head and project
  rules/           each role's rules, rendered by scripts/team.mjs (never edited)
  _vacancy.md      how to add a role
  product.md       owns WHAT and WHY
  cto.md           owns HOW; the only role that merges to main
  pm.md            owns the funnel, the metrics, the copy
  dev.md           writes code strictly to spec
  reviewer.md      reads the code whole before acceptance
  qa.md            runs the spec's tests as cases
  sre.md           build, deploy, run
  runner.md        rote work by instruction
scripts/
  team.mjs         declares the roles in the hub, renders and checks their rules
  behavior_metrics.mjs   numbers from the journal
specs/           SPEC_template.md: the assignment cto writes and dev reports in
queues/          per-role queues (hubd writes them; README only to start)
INBOX.md         a person's handoff lines, newest on top
recipes/         procedures any agent can run: triage, inventory, chronicle, probe
owner/           the owner's card: rhythm, interface, boundaries
chronicle/       the team's memoir, one chapter a week
prompts/         the hubd blocks for each agent client
HARVEST.md       extract projects, tasks and decisions from any dialog
examples/        a real working day
```

## Start

You need Node 18 or later, git, and the `hub` command (`npm i -g @bzdos/hubd`).

1. Copy the folder and make it a hub. Keep the copy **private**: it fills up with
   your work.

   ```sh
   npx degit bzdOS/hubd/hubd-company my-company
   cd my-company && git init
   export HUBD_DIR=$PWD HUBD_TEAM_DIR=$PWD
   hub init .
   ```

   `hub init` keeps the template's files, adds `HUBD.md` (the hub's mechanics, which
   hubd keeps current), and prints a way to connect one agent; this company connects
   its agents as under [Hire](#hire). `HUBD_DIR` is the hub; `HUBD_TEAM_DIR` is where
   its queues are, the same folder here.

2. Fill the placeholders (the ALL-CAPS words and `/path/to/...`) in `AGENTS.md` and
   `roles/team.json`, and delete the roles you do not need from both and from
   `roles/`. `roles/team.json` names your product, your repository and the check
   each role runs before a hand-in.

3. Give the product a card and a goal. In the product's repository:

   ```sh
   hub sync . -m "<what the product is, in a line>" --agent <you>
   hub section add <slug> goal "<what the next months are for>" --set --by <you>
   ```

   `hub sync` names the card after the folder and ties the folder to it, so an
   agent working there finds its project by itself. `<slug>` is the name it prints;
   put it in `roles/team.json` as `project`.

4. Declare the team and render its rules, back in the company folder:

   ```sh
   node scripts/team.mjs declare --by <you>
   node scripts/team.mjs render
   ```

   `declare` makes a role card for each role, the `owner` desk, the `company` card,
   and lists you in `owner-roles.json`. `render` writes `roles/rules/<role>.md`.

## Hire

Connect hubd once, in the product's repository, with this folder as the hub:

```sh
claude mcp add hubd --env HUBD_DIR=/path/to/my-company --env HUBD_TEAM_DIR=/path/to/my-company -- npx -y @bzdos/hubd
```

Other clients: the blocks in `prompts/`. Export the same two in the shell you start
agents from, so their `hub` commands reach this hub too. No `HUBD_AGENT`: every
role names itself in every write, and a write that names nobody is refused.

Then open a fresh session in the product's repository and paste `roles/cto.md` (or
any role) as the first message. It reads AGENTS.md and its rules, asks the hub where
it is, and waits on its queue.

## Watch

`hub board` in a terminal, or `hub serve` for the dashboard: the tracks, who is
live, what moved, and what waits for you. The rules view shows `AGENTS.md`. You do
not manage the agents; you manage the rules.

What waits for you: an escalation in the `owner` queue, a task assigned to you, a
task tagged `owner-go`. Answer an escalation on the company card, as AGENTS.md shows,
then render again: the answer reaches every role's rules. The same after a new fact
or a new goal on the product's card. `node scripts/team.mjs check` says when a render
is due, and exits 1 until it is done.

## Feed it

Three ways content enters the company without anyone typing cards by hand:

- **Harvest a dialog** (`HARVEST.md`): end any working chat with one prompt;
  projects, tasks and decisions land in the hub.
- **Inventory a machine** (`recipes/inventory.md`): point an agent at a server;
  get resource cards (host → services → endpoints) with typed edges and risks as
  tasks. A re-run is a drift report.
- **Triage a pile** (`recipes/triage.md`): meeting notes, brain dumps, email
  threads → deduplicated tasks with owners.

## The narrative layer (optional)

The same files that coordinate the team also narrate it. Fill the owner's card
(`owner/_template.md`: rhythm, interface, boundaries the agents may read but never
edit), and once a week an agent writes a chapter into `chronicle/`
(`recipes/chronicle.md`): what moved, the numbers (`scripts/behavior_metrics.mjs`),
past decisions judging the present, and at most three good questions for the owner
(`recipes/probe.md`). The design and its privacy model are in
[docs/narrative-layer.md](https://github.com/bzdOS/hubd/blob/main/docs/narrative-layer.md).

## Privacy

This template ships clean. Your copy is yours: the journal, the queues and the
owner's decisions will hold your work, so keep it private. Template updates never
touch your content: copy what you want, when you want.

## License

MIT.
