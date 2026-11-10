# PostHog Feed for Herdr

A [Herdr](https://herdr.dev) side panel that shows one PostHog project's events live as they arrive. The newest event is on top, with who did it, on what platform, on which screen or page, and how late it landed. Type to filter, and click an event to open it in PostHog. Add one panel per project, for example Staging and Prod next to Files and Changes.

![PostHog Feed](preview.png)

## Install

The simplest way is to ask the agent in your Herdr window:

> Add the Herdr mod from https://github.com/BenGlasser/herdr-posthog

Or do it by hand:

1. Copy `mods/posthog/` to `~/.config/herdr-app/mods/posthog/`.
2. Add a block for each project to one of your own layouts. Herdr's shipped layouts are read-only, so first make a copy with `herdr-app do layout.clone '{"name":"main","as":"my-layout"}'`.

   ```json
   { "id": "posthog-prod", "type": "block",
     "content": { "mod": "posthog",
                  "props": { "project": 12345, "label": "Prod", "prod": true, "block": "posthog-prod" } } }
   ```

3. Run `herdr-app check ~/.config/herdr-app/mods/posthog`.
4. Restart Herdr once, so it loads the bundled pixel font for the panel title.

## Setup

| Prop | Meaning |
|---|---|
| `project` | **Required.** The project id: the number after `/project/` in the project's PostHog URL. |
| `label` | The text in the header chip. Default: `Project <id>`. |
| `prod` | `true` makes the chip red, so production stands out. |
| `host` | Default `https://us.posthog.com`. For EU projects, use `https://eu.posthog.com`. |
| `block` | This block's `id` in the layout, so the panel can pause while it's hidden. |

The first time a panel opens, it asks for a PostHog **personal API key** (`phx_…`) with the **Query: Read** scope. It checks the key against the project, then saves it in the macOS Keychain (service `posthog-feed`, account = the host). Every panel on that host uses the same key.

## What it accesses

- **Network:** PostHog's query API (`POST <host>/api/projects/<project>/query/`), every 10 seconds while the panel is on screen. It stops while the panel is hidden and catches up when it's shown again.
- **Programs:**
  - `security`, to read and save the key in the Keychain
  - `open`, to open events and the key page in your browser
- **Files:** none outside its own folder.

It works on macOS only, because of the Keychain and `open`.

## More

[`RECIPE.md`](RECIPE.md) is the full brief: the exact look, behavior, query, limits, and checks that prove a build works. An agent can rebuild the mod from it in an empty folder.

The title font is Press Start 2P, under the SIL Open Font License ([`mods/posthog/fonts/OFL.txt`](mods/posthog/fonts/OFL.txt)).
