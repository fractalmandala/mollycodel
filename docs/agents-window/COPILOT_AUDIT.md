# Copilot sign-in: audit of where it lives

Read-only audit of `vscode/src/vs` (VS Code 1.135.0 plus our patches). Nothing here has been
changed yet. Counts come from searching the source; "visible" items were seen in screenshots.

## Why it is everywhere

`vscode/product.json` still carries Microsoft's `defaultChatAgent` block: the GitHub Copilot
extension ids, the GitHub auth provider, the entitlement URL
(`api.github.com/copilot_internal/user`), quota keys, and sign-up links. While that block is
present, the entitlement service starts, works out "signed out / free / pro", and publishes
context keys (`Entitlement.signedOut`, `Setup.installed`, ...). Every Copilot-aware feature
reads those keys, so each one shows its own sign-in prompt.

(`chatEntitlementService.ts` returns early when `defaultChatAgent` is absent: "we need a default
chat agent configured going forward from here". That is the single switch behind most of this.)

Our patches so far only cut three things: the Agents Window's hard sign-in gate and Copilot
session provider (patch 10), the "AI features disabled" default (patch 30), and, in patch 60,
the title bar Sign In button. Everything below is still live.

## The surface

**41 source files mention `defaultChatAgent`; 17 trigger the Copilot setup command
(`workbench.action.chat.triggerSetup`); 35 are gated on the entitlement keys.**

| # | Surface | Window | Where | What the user sees |
| --- | --- | --- | --- | --- |
| 1 | Title bar Sign In button | IDE | `chatSetup/chatSetupContributions.ts` | Fixed in patch 60 |
| 2 | Accounts menu (user icon): "Sign in to use GitHub Copilot", Sign Out, Copilot identity panel | Agents | `sessions/contrib/accountMenu/browser/account.contribution.ts` | The user icon at top right |
| 3 | Accounts menu entry in the IDE | IDE | `chatSetupContributions.ts` (`MenuId.AccountsContext`), `chatLanguageModelActions.ts` | "Sign in to use Copilot", Manage Language Models |
| 4 | **Language Models editor, "Add Models" button** (your screenshot) | Both | `chatManagement/chatModelsWidget.ts` (lines ~1288, 1661) | Opens the Copilot sign-in when there is no vendor to add |
| 5 | Status bar Copilot icon and its dashboard (Sign In, quotas, snooze) | IDE | `chatStatus/chatStatusEntry.ts`, `chatStatusDashboard.ts` | Copilot logo, bottom right |
| 6 | Chat setup flow: the "set up Copilot" view and its progress/install steps | IDE | `chatSetup/chatSetupRunner.ts`, `chatSetupController.ts`, `chatSetupProviders.ts` | Setup prompts inside chat |
| 7 | Quota and rate-limit notices | Both | `chatQuotaNotification.ts`, `chatAnonymousRateLimitedPart.ts` | "Upgrade / Sign In" banners |
| 8 | Signed-out models notification, SDK setup banner | Both | `agentHost/agentHostSignedOutModelsNotification.ts`, `agentHostSdkSetupNotification.ts`, `agentHostAuth.ts` | Banner offering sign-in |
| 9 | Session type picker greyed out as "sign in required" | Both | `agentSessions/sessionTypeAvailability.ts` | Copilot CLI / Claude entries |
| 10 | Chat tips that mention Copilot or sign-in | IDE | `chatTipService.ts`, `chatTipContentPart.ts` | Tip bubbles |
| 11 | Inline chat, SCM "generate commit message", agent plugins and MCP views gated on entitlement | IDE | `inlineChatActions.ts`, `scm/*`, `agentPlugin*`, `mcp*` | Hidden or disabled items |
| 12 | Voice, "continue in" actions that call setup | IDE | `voiceSessionController.ts`, `chatContinueInAction.ts` | Copilot-only commands |
| 13 | Agents Window onboarding tours, new-session view, policy-blocked screen | Agents | `sessions/contrib/onboardingTours/*`, `policyBlocked/*`, `newChatWidget.ts` | First-run flow |
| 14 | Bundled auth extensions: `github-authentication`, `microsoft-authentication`, `github` | Both | `vscode/extensions/` | Account sign-in for sync/Git, not Copilot |

Item 14 is different in kind: signing in to GitHub or Microsoft is a normal editor feature
(Git, Settings Sync), not a Copilot leftover, so I would keep it unless you say otherwise.

## Approaches

**A. Remove the root.** Make the product config not declare a Copilot chat agent. The
entitlement service then never starts, and items 1 to 12 mostly go quiet by themselves.
Cheap, but untested: some code reads `product.defaultChatAgent` without a guard
(for example `extensionGalleryService.ts`, `chatWidget.ts:1483`, `chatStatusDashboard.ts:51`),
and I do not yet know how chat behaves with no entitlement at all. It needs one test build to
find out, plus patches for any code that throws.

**B. Cut each surface.** Patch the 17 setup-triggering files and gate the rest. Certain
but wide: about 25 files, and each new upstream version brings new ones back.

**C. Both (recommended).** Try A first. Whatever still shows afterwards is exactly the list for
B, and it is much shorter. Independent of the result, redirect two things to our own providers
page (`workbench.action.pi.manageProviders`): the **Add Models** button (item 4) and the
Agents Window account menu's sign-in entry (item 2), so they lead somewhere useful instead of
disappearing.

## What was done (patch `60-ui-cleanups`; code only, not yet built)

One switch, `MOLLYCODEL_NO_COPILOT` in `workbench/services/chat/common/mollycodelNoCopilot.ts`,
declares that this app has no Copilot. With it on:

1. **The entitlement service never starts.** No calls to GitHub, no signed-out / free / quota
   states. Chat setup is marked complete, so the welcome-and-setup prompts, the "generate code"
   entry and the hidden-sessions-list behaviour that depend on "setup not completed" stay off.
   The `defaultChatAgent` block stays in the product config, because the extension gallery
   reads it without a check (`extensionGalleryService.ts` 1164 and 1992,
   `abstractExtensionManagementService.ts` 987).
2. **Language Models "Add Models"** opens the providers page (`workbench.action.pi.manageProviders`)
   instead of the Copilot sign-in.
3. **Agents Window user button** shows "AI providers" instead of "Sign In"; its menu has
   "Manage AI providers" in place of "Sign in to use GitHub Copilot".
4. **Status bar Copilot item** is never created.
5. **Agents Window workspace picker** no longer offers "Sign in to GitHub".
6. New chats in the side panel start with Pi, and a remembered "Local" no longer wins.
7. The title bar Sign In button stays removed.

VSCodium's own `00-copilot-fix-action-condition` patch already replaced the `Setup.installed`
gates in this tree, so nothing further was needed there.

## Left alone on purpose

- GitHub and Microsoft sign-in extensions (Git, Settings Sync): normal editor features.
- The ChatGPT account section of the Agents Window account panel: it is behind
  `chat.agentHost.codex.enabled`, which is off, so it does not show.
- The "Sign-In Required" overlay in `sessionsPolicyBlocked.ts`: only appears under an admin
  policy, which does not exist here.
- Remaining Copilot-worded text in tips and in code paths that can no longer be reached
  (setup runner, quota notices, anonymous rate-limit part). Unreachable, so not edited.

## Not verified

This was checked by type-checking and by reading the conditions, not by running the app. One
build is needed to confirm that nothing Copilot-related still shows and that chat behaves
normally with no entitlement. Anything that still appears goes on the list for a second pass.
