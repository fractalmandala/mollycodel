# Agents Window and Side Chat — Specification

Status: draft 0. Written 2026-10-02 from a verified baseline build of upstream 1.135.0.
Every claim is tagged **[verified]** (observed in a build or in source), **[reported]**
(user observation we could not independently capture), or **[open]** (decision or
unknown). Nothing untagged should be trusted.

## 1. Goal

Two chat surfaces over one set of agent sessions, with multi-provider models and
orchestration built on Pi:

1. **Side chat** — a chat panel in the editor window's right (secondary) side bar.
2. **Agents Window** — a second, full window that is a cockpit across projects.

A conversation can be moved between the two with its context intact, in both
directions. No provider lock-in: Anthropic is roughly 10% of intended usage.

## 2. Verified baseline

| Fact | Status |
| --- | --- |
| Fresh build from `vscodium-master` completes (`./dev/build.sh -s`, Node 24.x, ~15–20 min on Apple Silicon) | verified |
| The build contains the Agents Window layer `src/vs/sessions` and its bundle `sessions.desktop.main.js` | verified |
| `VSCodium --agents` opens the Agents Window (`windowsManager#openAgentsWindow` in log) | verified |
| Window opens behind a forced GitHub sign-in modal | verified (screenshots) |
| `--skip-sessions-welcome` gets past the modal; editor and Agents windows can be switched between | reported |
| With the modal gone, the only session type is **Copilot** and the Models picker says "Sign in to use Copilot" | reported (screenshots) |
| Editor window's right side bar is empty ("Drag a view here to display") | reported (screenshot) |
| Test launches need short profile paths (macOS Unix-socket limit ~104 chars); `/tmp/ag/...` works | verified |

Conclusion: the window shell exists and opens; nothing in it is usable until a
non-GitHub provider is registered.

## 3. Architecture

```
Editor window         Agents Window
 (side chat view)      (sessions sidebar, composer, run views)
        \                /
         \   attach    /
          v            v
       Agent host process  (Node, long-lived)
        ├─ AgentService / orchestrator (upstream)
        ├─ PiAgent : IAgent        <-- new
        │    └─ @earendil-works/pi-coding-agent (AgentSession per chat)
        └─ session store (source of truth)
```

Principles:

- **The session lives in the host, not in a UI.** Both windows are clients.
  Moving a chat is re-attaching a view, not copying a transcript.
- **Plug in at the existing seam.** The host defines `IAgent` in
  `src/vs/platform/agentHost/common/agent.ts` [verified]. `PiAgent` is a new
  implementation of it, like the Copilot/Claude/Codex harnesses it replaces.
- **Leave behind behavior, keep the contract.** We do not reproduce Copilot's
  behavior; we conform to the host's contract.

## 4. Why the side chat and window were empty, and the fix

Root cause [verified]: VSCodium's own patch `patches/00-copilot-fix-action-condition.patch`
changes the default of `chat.disableAIFeatures` from `false` to `true` and gates the
Chat view on `!config.chat.disableAIFeatures`. That setting is the master switch:
`IAgentHostEnablementService.enabled` is `!isWeb && !disableAIFeatures`, and every
agent-host contribution (the prewarm that spawns the host process, the local sessions
provider, the right-side Chat view) is gated on `enabled`. With the default `true`,
nothing starts: no `agenthost.log`, no provider, no Chat view.

The Chat view is registered into the auxiliary (right) side bar with `isDefault: true`
(`chatParticipant.contribution.ts`) [verified]; it also needs a registered agent
(`chatPanelParticipantRegistered`) [verified in source].

Fix: `patches/user/30-chat-enable-ai-features.patch` restores the default to `false`.
Verified equivalent by setting `"chat.disableAIFeatures": false` in a throwaway
profile (see Phase 2 below). The patch itself is verified by reverse-apply only until
the next rebuild.

Caveat [open]: re-enabling brings back every Copilot-flavored surface that setting
was hiding in the *editor* window (setup/sign-in welcome, title-bar sign-in, inline
suggestion nudges). None were reported in testing so far; sever as they appear.

## 5. Moving a chat between surfaces

Upstream already has the plumbing [verified]:

- Command `Open Agents Window` (Cmd+Shift+A), and an action that opens the current
  chat session in the Agents Window by passing `sessionResource` to
  `nativeHostService.openAgentsWindow`.
- It is currently offered only for "first-party agent-host sessions". A `PiAgent`
  session is an agent-host session, so it should qualify. **[open]**: confirm the
  precondition in code and add the reverse direction (Agents Window to side chat)
  if absent.

Context is preserved because both surfaces read the same host-owned session.

## 6. Pi integration

Source facts, read from the published packages (v1.0.0, MIT, TypeScript):

- `@earendil-works/pi-ai`: unified multi-provider LLM layer, about 40 providers
  (Anthropic, OpenAI, Google, Vertex, Bedrock, Azure, Mistral, Groq, xAI, DeepSeek,
  OpenRouter, Together, others), some with OAuth. [verified]
- `@earendil-works/pi-agent-core`: `Agent` with `subscribe`, `prompt`, `continue`,
  `abort`, `steer`, `followUp`, `beforeToolCall`/`afterToolCall`. Events:
  `agent_start/end`, `turn_start/end`, `message_start/update/end` (text and
  thinking deltas), `tool_execution_start/update/end`. [verified]
- `@earendil-works/pi-coding-agent` (NOT used, see decision below): `createAgentSession()` embeds the full coding
  agent in-process: tools, `SessionManager` (persistent entry tree with branching),
  `AgentSessionRuntime` (`newSession`, `switchSession`, `fork`, `importFromJsonl`),
  skills, MCP, compaction, extensions. [verified]

Decision (revised 2026-10-02, user-approved): depend on **`pi-ai` + `pi-agent-core`
only**, not `pi-coding-agent`. Earlier decision was to embed pi-coding-agent's tool
set; reversed after measuring: pi-coding-agent bundles 444 MB of `node_modules`
(297 MB is `@esbuild/*` for every OS) versus 100 MB for the two lighter packages
(mostly the provider SDKs: openai 27 MB, anthropic 13 MB, google 11 MB). Most of what
pi-coding-agent adds (session files, skills, MCP, compaction) duplicates what the
Agents Window host already owns (Customizations: Agents/Skills/Instructions/Hooks/MCP/
Tools; host-owned session persistence). Cost of the switch: we write the file/shell
tools (about five) as `AgentTool`s with approvals through the host. Reference: the
PI-Desktop app (github.com/vastsa/PI-Desktop) is built on exactly `pi-ai` +
`pi-agent-core`, stores credentials in the OS keychain, and organizes work as
Project -> Session -> Agent with subagents and a parallel-session orchestrator
(read at README level only). Pi itself has no account or sign-in; only optional
provider OAuth (e.g. ChatGPT subscription) exists.

Mapping to `IAgent` (to be validated against the interface and host spec):

| Pi | Host |
| --- | --- |
| `message_update` text/thinking deltas | `onDidChatProgress` signals |
| `tool_execution_*` | tool-call signals |
| `agent_start` / `agent_end` | turn begin / end |
| `abort()` | chat abort |
| `steer()` / `followUp()` | input while a turn is running |
| `pi-ai` model catalog | `IAgent.models` observable |
| `SessionManager` entries | opaque chat backing via `onDidChangeChatData` |
| `AgentSessionRuntime.fork()` | host fork capability |

## 7. Orchestration (initial scope)

Start with **agent files and skill files**, not graphs. (User decision.)

- Agent files: markdown with frontmatter (role, model, tools, instructions).
- Skill files: instruction bundles loaded on demand (Pi supports skills natively).
- A lead agent can spawn sub-agents defined by those files; each run gets its own
  git worktree to avoid collisions.
- Graph-style authored pipelines are deferred; the file formats do not change if
  they are added later.

The Agents Window is the cockpit: a sidebar of projects (pinned first), each with
sessions and runs, status per run (working / blocked / idle). Precedents read for
this: herdr (persistent server, attach/detach, agent states), Orca (worktree-scoped
sessions, project sidebar), OpenChamber/opencode (headless server, multiple clients).
These were read at catalog level only; they are inspiration, not specification.

## 8. Phases

0. Baseline build and window reachable. **Done** (modulo the items tagged reported).
1. **Done and verified (2026-10-02).** `patches/user/10-sessions-sever-github.patch`:
   welcome/sign-in flow skipped on desktop; Copilot sessions provider no longer
   registered. Verified on a rebuild: `VSCodium --agents` (no bypass flag) opens the
   Agents Window with no sign-in modal, no Copilot session type, an empty Sessions
   list, "Start by picking a workspace", a composer, and a Models button. Renderer
   log shows no DI errors or exceptions. Two warnings seen:
   `No harness descriptor found for session type file` (expected: nothing registered
   yet). An `[AgentsHandoff] IPC received: folderUri=… sessionResource=…` log line
   confirms the window-handoff channel carries a session resource.
   Not yet cut, deliberately: `IGitHubService` is injected into the agent-host
   sessions providers (`baseAgentHostSessionsProvider.ts`, local and remote), so its
   registration stays; GitHub UI contributions (`contrib/github`, `codeReview`,
   `accountMenu`) are still loaded and inert without an account. Revisit after
   `PiAgent` shows real dependencies.
2. **Done and verified (2026-10-02).** `patches/user/20-agenthost-pi-agent.patch` (originally an echo stub, since
   replaced by the real agent)
   adds `node/pi/piAgent.ts` (echo stub implementing `IAgent`, no auth, no protected
   resources, one model "Pi Echo (stub)") and registers it in `agentHostMain.ts`.
   Type-checks against the real `IAgent` (TypeScript 7 native, ~14 s via
   `npm run typecheck-client`; checker validated by a planted error).
   With `chat.disableAIFeatures=false`: `agenthost.log` shows
   "Registering agent provider: pi"; the Agents Window creates a
   `local-agent-host:agent-host-pi:` session; Models picker shows "Pi Echo (stub)"
   [reported]; a sent message echoes "Pi (echo stub) heard: …" [reported]; editor
   window stays in sync [reported]. Not yet tested explicitly: "open in Agents
   Window" from the side chat carrying a session across; exact appearance of the
   editor's right-side Chat view. Enabling patch: `30-...` (see section 4).
3. **Real Pi with a full provider manager. Done and verified (2026-10-02).**
   Verified by the user ("all green") and from logs: `[Pi] publishing 294 models from
   6 providers` = Anthropic 16 + OpenCode Zen 79 + OpenCode Go 29 + xAI 4 + two
   custom OpenAI-compatible endpoints (85 + 81, fetched live); keys survive a full
   quit/relaunch from the OS keychain.
   Patches: `20-agenthost-pi-agent.patch` (agent, provider runtime, tools, shared
   contract), `30-chat-enable-ai-features.patch`, `40-deps-pi.patch` (`pi-ai` +
   `pi-agent-core` only), `50-pi-providers-ui.patch` (Providers editor + model
   picker rewire). Tooling: `dev/make-user-patch.py` generates a patch containing only
   our own change (see section 10); use it, do not hand-diff.
   - **Agent loop:** `pi-agent-core` `Agent` per chat, streaming text and reasoning,
     usage, errors; abort emits nothing (host dispatches `ChatTurnCancelled`).
   - **Tools:** read_file, list_dir, write_file, edit_file, bash. Writes and shell
     always need approval (host policy applied via `permissionKind`/`permissionPath`);
     reads outside the working directory need approval; `.env*`, `~/.ssh`, `~/.aws`,
     `~/.gnupg` are blocked outright, enforced both at approval and inside each tool.
     All of read, write-approval, shell-approval, secret-block and denial were
     exercised by the user in the app [reported].
   - **Providers (replaces the earlier dotenv key file, now deleted):**
     - Editor: `Pi: Manage Providers` (webview editor, both windows). Rows with
       enable toggle, Make default, edit, delete; default-model selector; Add provider
       dialog with filter, subscription section (disabled, "coming next"), API-key
       section, Custom endpoint, Fetch models. Shown when the host has no models: a
       banner with the host's reason.
     - Storage: API keys in the OS keychain (`ISecretStorageService`); non-secret
       config in application storage (`pi.providers.v1`). The editor never receives a
       stored key, only `hasKey`.
     - Delivery to the host: the renderer pushes the full payload in memory through
       the host's `handleAuthenticationToken` hook (resource `pi:providers`, no
       protected resource declared, so the workbench auth glue never touches it), on
       every change, on host start, with retry; the host persists nothing.
     - Runtime: built-ins loaded one by one from pi-ai; custom rows via
       `createProvider` (OpenAI- or Anthropic-compatible, optional keyless);
       Pi's catalog is authoritative for known model ids, unknown ids work as plain
       text models (rule taken from PI-Desktop ADR 0027).
     - Model picker: "Sign in to use Copilot" dead end replaced by "No models
       available / Add an AI provider...", which opens the editor.
   - **Reference app:** PI-Desktop (github.com/vastsa/PI-Desktop) cloned to
     `reference/PI-Desktop` (git-ignored; re-clone it, never commit it) and read in depth (secrets spec, provider schema, ADR
     0012/0027, preset catalog, model discovery). It is **LGPL-3.0**: used for design
     knowledge only; no code copied. Borrowed ideas: UI never sees keys; runtime gets
     keys ephemerally; live model discovery from the provider's own endpoint; pi-ai is
     authoritative for known-model metadata; subscription ("vendor account") logins
     as a separate credential per provider row.
   - **Lessons that cost real time (do not repeat):**
     1. *The app's packaging silently drops dotfiles from node_modules.* The build
        runs `filter(depFilterPattern)` (gulp, default `dot:false`) right after
        collecting production deps, so any hidden file a dependency imports at runtime
        is missing in the built app while working in a normal install. Pi's
        `providers/all.js` imports `data/.manifest.json`, so loading it fails in the
        built app. A `.moduleignore` include rule does NOT help (the file is already
        gone upstream of it; this was tried and removed). Fix used: never import
        `providers/all`; load providers individually. Verify packaging claims by
        importing from `node_modules.asar` with the built app's own runtime
        (`ELECTRON_RUN_AS_NODE=1 <app binary> script.mjs`), not by reasoning.
     2. *Never swallow errors in the host.* An empty `catch` hid the failure above for
        a full build cycle. The host now logs `[Pi] received/publishing/failed`, the
        renderer logs each push, and the editor shows the reason.
     3. *Baselines move.* After every `./dev/build.sh -s` the tree's helper commits are
        reset, so `git diff` mixes other patches into ours. Use `dev/make-user-patch.py`.
     4. *Test paths:* keep everything the user must touch visible under ~
        (sandbox: `pi-sandbox/`, test app profile: `test-run/`); macOS socket paths
        must stay under ~100 characters, which these satisfy.
   - **Still to do in this phase:** subscription logins (Claude Pro/Max, ChatGPT,
     Copilot, Kimi, Meta, Grok: `pi-ai` supports them natively; separate credential
     per row, refresh owned by the trusted side); session persistence (a session from
     a previous run cannot be restored: `Provider pi could not describe ...`); a
     browsable model picker for hundreds of models; vendor presets for user routers.
3b. **OpenCode as a second agent. Done and verified (2026-10-02).** User: "it works perfecto".
   Host log: `[OpenCode] server ready` ~0.8 s after launch, `publishing 140 models`.
   Files: `node/opencode/{opencodeServer,opencodeHttp,opencodeAgent}.ts` in patch 20.
   - **Design:** the host starts one private `opencode serve` (127.0.0.1, port chosen by
     the OS, random password held only in memory, binary found via `OPENCODE_BIN`,
     `~/.opencode/bin`, Homebrew) and talks to it over plain HTTP + its global event
     stream. OpenCode reads the user's own config, so their providers, keys, agents,
     skills, MCP servers and `AGENTS.md` all apply with no key handling here.
   - **Not the SDK:** `@opencode-ai/sdk` was evaluated and dropped. Its v1 types lag
     the server (this OpenCode streams text via `message.part.delta` and asks via
     `permission.asked`, neither in v1 types) and v2 is a different, in-flux model.
     Endpoints used: `GET /config/providers`, `POST /session`,
     `POST /session/{id}/message`, `GET /session/{id}/message` (history),
     `POST /session/{id}/abort`, `GET /global/event` (SSE, carries `directory`),
     permission reply `POST /api/session/{sid}/permission/{rid}/reply` with a fallback
     to `/session/{id}/permissions/{pid}`; questions declined via
     `/api/session/{sid}/question/{id}/reject`. Every call takes `?directory=`.
   - **Mapping:** part updated + part delta -> `ChatResponsePart`/`ChatDelta`/
     `ChatReasoning` (parts are created empty, deltas append by `partID`); tool parts ->
     start/ready/complete; `permission.asked` -> `pending_confirmation` with kinds
     bash->shell, edit/write->write, read/list/glob/grep->read; `session.idle` -> turn
     complete (with a 400 ms fallback on request completion); `session.error` -> error.
     Sessions persist: `providerData` = `{sessionId, directory, model, agent}`; history is
     rebuilt from OpenCode (text and reasoning only; tool calls omitted).
   - **Validated before building** with `dev/check-opencode-protocol.mjs` against the real
     server using a free Zen model (zero cost): providers, empty-body session create, SSE
     parsing, deltas, idle, history, abort all PASS. Method worth repeating: spike the
     protocol with a script first, then build.
   - **Facts worth knowing:** one trivial turn costs ~40,000 input tokens because
     OpenCode loads the user's `AGENTS.md`, skills and MCP tool definitions. OpenCode's
     own permission rules decide when it asks; Pi's `.env*`/`~/.ssh` guard does NOT apply
     to OpenCode tools. The user's OpenChamber server (port 60527) is separate and
     untouched.
   - **Still to do:** selecting an OpenCode agent (`build`/`plan`/`fractal-agentic`) from
     the UI (needs `getChatCustomizations`), answering OpenCode's questions through the
     host's input requests, tool calls in restored history, discovering the user's
     existing OpenCode sessions as chats, optional "Import providers from OpenCode" for
     Pi (user-initiated, since it reads keys).
4. Orchestration: sub-agents from agent files, worktrees, run status in the window.
5. Harness: agent/skill authoring UX, evals, receipts, MCP brokering.

## 9. Open decisions and risks

- **Source layout.** Changes must be reproducible from a clean fetch. Plan: patch
  files in `patches/`, plus new files added by a patch, not edits inside `vscode/`.
  [open: patch granularity and numbering]
- **Models picker.** The Agents Window's model types and "upgrade" prompts are
  Copilot-shaped. The window may need its picker widened for non-Copilot models.
  [open, highest risk]
- **"Sign in to use Copilot" in the Models picker (observed after Phase 1).**
  Source: shared workbench picker, `workbench/contrib/chat/browser/widget/input/modelPicker/`
  (`modelPickerPresentation.ts`, `modelPickerItemSections.ts`). It appears when there
  are no live models AND `modelPickerRequiresSetup` is true (entitlement
  Unknown/Available, not anonymous, no BYOK models) [verified in source]. It is the
  generic empty state, not the removed Copilot provider. Expected to clear when
  `PiAgent` publishes models. Still needed in Phase 3: replace the Copilot wording and
  the `onRequestSetup` action with Pi-provider setup (add key / provider sign-in) for
  the "Pi registered but unconfigured" state. [open]
- **BYOK layer.** `agentHostByokLm.ts`, `byokLmProxyService.ts`,
  `byokResponsesTranslation.ts` exist in the host [verified]. Whether they are the
  right path for non-GitHub model sources is [open].
- **Reference harnesses.** `node/copilot/` keeps 15 support files but not
  `copilotAgent.ts`; `node/claude/` keeps only `claudeProxyAuth.ts`; `node/codex/`
  is absent [verified]. Originals are recoverable with `git show HEAD:<path>` in
  `vscode/` (upstream is `HEAD`, patches are uncommitted) [verified]. Use them only
  to answer questions `IAgent` and the host spec leave open.
- **Session storage location.** Pi persists to its own directory by default. Whether
  the host moves it under host storage so both windows share one source of truth
  is [open].
- **Tool safety.** Pi's tools run shell and edit files. Mapping its permission and
  project-trust model onto the host's approval flow is [open]; read Pi's
  `security.md` and `project-trust` first.
- **Packaging (measured).** The production build marks npm packages `external`
  (`packages: 'external'` in `build/lib/optimize.ts`), so deps are not bundled into
  `agentHostMain.js`; they are resolved at runtime from the app's `node_modules`
  [verified]. Adding the three `@earendil-works/*` packages to `dependencies` in
  `package.json` + lockfile is enough to ship them (`patches/user/40-deps-pi.patch`:
  221 packages added, 0 removed, 5 existing packages lose their `dev` flag) [verified
  by structural lock diff; real `npm ci` + build not yet run]. Electron 42.8.1 ships
  Node 24.18.1 (Pi needs >= 22.19) [verified]. Pi has no native modules; its heavy
  parts are WebAssembly [verified from package.json]. **Size problem:**
  `pi-coding-agent` would have bundled its own `node_modules` (444 MB installed,
  ~297 MB `@esbuild/*` for every OS/arch) against a current app of ~1.0 GB
  [measured]; avoided by depending on `pi-ai` + `pi-agent-core` only (100 MB, 74
  packages added to the lock, 0 removed) [measured]. `patches/user/40-deps-pi.patch`
  now adds just those two. Remaining size lever if needed: provider SDKs we never
  use. [open]
- **Package scope.** Current npm scope is `@earendil-works/*` (an older
  `@mariozechner/*` scope also appears in search results). Pin the current scope
  and exact versions. [open]
- **Merge cost.** Each upstream version bump means rebasing our patches against
  fast-moving `vs/sessions` and agent-host code. [open, accepted]

## 10. Build and test notes

- Build: `./dev/build.sh` fetches and builds; `./dev/build.sh -s` rebuilds from the
  existing `vscode/` without re-fetching. Use Node 24.x (`fnm use 24.21.0`).
- Run the built app: `VSCode-darwin-arm64/VSCodium.app/Contents/MacOS/VSCodium`
  with `--agents --skip-sessions-welcome --user-data-dir=/tmp/ag/ud
  --extensions-dir=/tmp/ag/ext` (short paths required).
- **Rebuild gotcha.** A second `./dev/build.sh -s` fails at the CLI step
  (`mkdir: openssl: File exists` from `build_cli.sh`) because the first build left
  `vscode/cli/openssl` and `vscode/cli/vscode-openssl-prebuilt-*.tgz`. The desktop
  app is already built by then and is usable; delete those two before rebuilding to
  get a clean exit. A rebuild also deletes `VSCode-darwin-arm64`, so quit any
  running test instance first.
- Our patches live in `patches/user/` (applied last by `prepare_vscode.sh`). Author
  one by committing the patched `vscode/` tree as a throwaway "VSCODIUM HELPER"
  commit, editing, then `git diff -U1 > ../patches/user/NN-name.patch`; confirm
  with `git apply --check` after `git stash`.
- **Generating our patches:** `python3 dev/make-user-patch.py patches/user/NN-name.patch
  --new <files added in full> --edit <path:substring of the line(s) we added> --revert-file
  <path:script defining revert(text)>` builds a temporary git index whose baseline is
  "the tree without our change" and verifies the patch with `git apply --cached --check`.
  Paths are relative to `vscode/`.
- **Build/launch loop:** `rm -rf vscode/cli/openssl vscode/cli/vscode-openssl-prebuilt-*.tgz`
  (stale from the previous build), quit the test instance, `./dev/build.sh -s` (about
  10-20 min), launch `VSCode-darwin-arm64/VSCodium.app/Contents/MacOS/VSCodium --agents
  --user-data-dir=<repo>/test-run/ud --extensions-dir=<repo>/test-run/ext`, then read
  `test-run/ud/logs/<ts>/agenthost.log` (`[Pi]` lines) before asking the user to test.
  Type-check without building: `npx tsc --project ./src/tsconfig.json --noEmit
  --skipLibCheck` in `vscode/` (about 15 seconds).
- A test instance must be quit by its profile dir, never by app name, so a
  separately running installed VSCodium is not touched.
