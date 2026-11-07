# Theme variants

## Overview

The app has two variants of the Hallmark Terminal theme (D15):

| Setting | Variant | Description |
|---|---|---|
| Light (default) | Cream | Warm cream paper, black ink, and a dark forest green accent |
| Dark | Terminal | Near-black paper with a green cast, pale ink, and a bright green accent |
| System | Cream or Terminal | Follows the light or dark setting of the computer. The app changes when that setting changes |

Select the setting in **Storage > Appearance**.
The main process keeps the setting in `userData/preferences.json`.
It does not use `settings.json`, because a vault move writes that file again.

## How the variant gets to the window

1. The main process reads `preferences.json` and sets `nativeTheme.themeSource`. A missing or damaged file gives `light`.
2. `nativeTheme.shouldUseDarkColors` gives the variant. The window background gets the paper color of that variant, so the first frame has the correct color.
3. The main process adds `--sct-theme=<variant>` to the renderer arguments. The preload gives this value as `window.sct.theme`.
4. `main.tsx` sets `data-theme` on the root element before the first render. The CSP blocks inline scripts, so the bundled entry does this.
5. A change of the setting, or of the OS setting when the setting is System, sends `theme:changed` to the window.

## Role tokens

`styles.css` declares all colors. `:root` holds the Terminal values. `:root[data-theme="cream"]` replaces only token values.
The Cream values come from the reference screenshot that the user supplied (2026-11-04).

| Token | Terminal | Cream | Cream hex |
|---|---|---|---|
| `--color-paper` | oklch(12.5% 0.012 150) | oklch(94% 0.025 83) | `#f3ead9` |
| `--color-paper-2` | oklch(16% 0.016 150) | oklch(96.9% 0.02 85) | `#fbf4e6` |
| `--color-paper-3` | oklch(20.5% 0.022 150) | oklch(89.1% 0.03 86) | `#e4dac5` |
| `--color-ink` | oklch(94% 0.03 140) | oklch(0% 0 0) | `#000000` |
| `--color-ink-2` | oklch(82% 0.05 142) | Same as ink | |
| `--color-muted` | oklch(64% 0.06 145) | Same as ink | |
| `--color-rule` | oklch(27% 0.028 148) | oklch(77.9% 0.03 85) | `#c0b6a2` |
| `--color-rule-2` | oklch(38% 0.045 146) | oklch(60% 0.04 86) | Darker than the reference `#9a8e74`, to reach 3:1 |
| `--color-input-border` | oklch(50% 0.045 146) | Same as ink | `#000000` |
| `--color-accent` | oklch(87% 0.2 142) | oklch(46.1% 0.121 145) | `#216929` |
| `--color-accent-ink` | oklch(14% 0.02 150) | Same as ink | `#000000` |
| `--color-accent-wash` | oklch(23% 0.06 145) | Same as paper-3 | `#e4dac5` |
| `--color-focus` | Accent | Ink | `#000000` |
| `--color-accent-text`, `-line` | Accent | Ink | `#000000` |
| `--color-accent-edge` | Accent | Ink | `#000000` |
| `--color-hover-ink` | Accent ink | Paper | |
| `--color-scrim` | Paper at 86% | Paper at 86% | |

In Cream, the dark green is only a fill for the wordmark and the 4px rule above the selected tab.
The primary button also uses the green fill, with black text.
Black text on this green has 3.1:1. This is a deliberate exception to the 4.5:1 text rule.
All other Cream text, lines, and focus rings are ink.

## Selected tab

Both variants use the same treatment:

| Place | Selected style |
|---|---|
| Header links | Ink text, a 4px accent rule at the top (`::before`), and a 1px ink rule at the bottom (`::after`) |
| Sharing tabs | Ink text, a 4px accent rule at the top (`::before`), and a 1px ink rule at the bottom (`::after`) |

The 1px ink rule marks the selected state. The selected tab has no green text.

The app uses no shadows.

## Contrast

The rules are 4.5:1 for text and 3:1 for control edges and state indicators (WCAG 1.4.3 and 1.4.11).
The values come from the tokens, converted to sRGB relative luminance.

| Variant | Pair | Ratio | Use |
|---|---|---|---|
| Cream | Ink on paper | 17.6 | Body text, links, status text, focus, selected-tab rule |
| Cream | Ink on paper-2 | 19.2 | Panel and header text, links and focus in panels |
| Cream | Ink on paper-3 | 15.1 | Hover text |
| Cream | Green on paper | 5.6 | 4px selected-tab rule of the sharing tabs only. Not text or focus |
| Cream | Green on paper-2 | 6.2 | 4px selected-tab rule in the header only |
| Cream | Ink on green | 3.1 | Primary button and wordmark. Deliberate exception to the 4.5:1 text rule |
| Cream | Paper on ink | 17.6 | Button hover |
| Cream | Input border on paper | 17.6 | Input and select edges |
| Cream | Input border on paper-2 | 19.2 | Input and select edges in panels |
| Cream | Rule-2 on paper | 3.3 | Panel edges |
| Cream | Rule on paper-2 | 1.8 | Decorative separators only |
| Terminal | Ink on paper | 17.1 | Body text, selected-tab rule |
| Terminal | Ink-2 on paper-2 | 11.3 | Secondary text |
| Terminal | Muted on paper-2 | 5.9 | Help text |
| Terminal | Accent on paper | 14.5 | Links, status text, focus, 4px selected-tab rule of the sharing tabs |
| Terminal | Accent on paper-2 | 13.9 | 4px selected-tab rule in the header |
| Terminal | Accent ink on accent | 14.3 | Primary button |
| Terminal | Input border on paper | 3.4 | Input and select edges |
| Terminal | Input border on paper-2 | 3.3 | Input and select edges in panels |
| Terminal | Rule-2 on paper | 2.1 | Panel edges and separators. Inputs do not use this token |

Disabled controls use opacity 0.55. WCAG does not apply the contrast rules to disabled controls.

## Screenshots

The full-window screenshots are 1200 × 800 on Windows. The Links image is a panel capture.

| Screen | Cream | Terminal |
|---|---|---|
| Unlock | ![Cream unlock](media/themes/cream/unlock.png) | ![Terminal unlock](media/themes/terminal/unlock.png) |
| Projects | ![Cream projects](media/themes/cream/projects.png) | ![Terminal projects](media/themes/terminal/projects.png) |
| Sharing | ![Cream sharing](media/themes/cream/sharing.png) | ![Terminal sharing](media/themes/terminal/sharing.png) |
| Send | ![Cream send](media/themes/cream/send.png) | ![Terminal send](media/themes/terminal/send.png) |
| WebRTC | ![Cream WebRTC](media/themes/cream/webrtc.png) | ![Terminal WebRTC](media/themes/terminal/webrtc.png) |
| Connection link review | ![Cream connection link](media/themes/cream/connection-link.png) | ![Terminal connection link](media/themes/terminal/connection-link.png) |
| Link receipt | ![Cream link receipt](media/themes/cream/link-receipt.png) | ![Terminal link receipt](media/themes/terminal/link-receipt.png) |
| Share confirmation | ![Cream share confirmation](media/themes/cream/share-gate.png) | ![Terminal share confirmation](media/themes/terminal/share-gate.png) |
| Links registration | ![Cream links](media/themes/cream/links.png) | ![Terminal links](media/themes/terminal/links.png) |
| Storage | ![Cream storage](media/themes/cream/storage.png) | ![Terminal storage](media/themes/terminal/storage.png) |

The new screens use the same role tokens and components.
The **Links** image shows the packaged registration controls.
The screenshots use synthetic project, secret, and recipient metadata.
Task 4.6 is complete for these screens on Windows.
The macOS and Linux variants need separate evidence.

## What stays the same

- Wallet pass colors in `src/main/cards.ts` and the app icon in `build/icon.svg` use the Terminal colors in both variants.
- Martian Mono, the three weights, the square surfaces, and the 1px rules are the same in both variants.
