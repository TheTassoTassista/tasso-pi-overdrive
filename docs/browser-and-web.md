# Browser and web workflows

Use `web_search` to discover current sources only after configuring a provider credential, `web_fetch` to read public pages without credentials, and `agent_browser` only when rendered DOM, interaction, screenshots, downloads, authenticated state, or browser-specific behavior matters.

Search credentials are opt-in. No key is stored by this package. Export a provider variable in the environment that launches Pi or use `/web-tools`; never paste keys into prompts or repository files. `web_fetch` rejects loopback, private-network, metadata, and non-HTTP(S) targets.

Browser default:

1. Open a page in a fresh isolated session.
2. Take an interactive snapshot.
3. Act only on current refs or stable semantic locators.
4. Snapshot after navigation or DOM mutation.
5. Verify requested artifacts exist before claiming success.
6. Close the managed session after the task.

In an Overdrive runtime allocation the safety hook requires the exact assigned `--session` and, on launch, the exact assigned `--profile` with `sessionMode=fresh`. Browser traffic is intentionally not Bubblewrap-network-isolated; profile/state isolation and the browser tool's own URL policy are the applicable boundaries.

Do not select a personal Chrome/Zen profile by default. For signed-in work, ask the user to authorize the profile boundary and assume visible page content can enter model context. The installed Zen browser is Firefox-based and is not used as a Chromium executable.

For local UI tests, start the application on a worktree-unique port, restrict the browser to the expected domains when practical, and save screenshots under the active repository or an explicitly approved artifact directory.
