# Neon Xangi Console design

[日本語](../console-design.md)

The Console is a host-side setup, configuration, and control instrument, not a chat surface. It uses a compact dark canvas, cobalt status accents, visible trust-boundary language, and dense monospace operational data. It first states the concrete job—configure connections and response scope—and three next steps. The visual hierarchy is intentionally linear: settings, runtime health, permission policy, approvals, then operation history. Abstract hero copy and unexplained security terminology do not serve as primary headings.

## Tokens and components

- Canvas and surfaces use near-black blue OKLCH values; borders remain visible without card-heavy decoration.
- Space Grotesk/Avenir Next is the display stack, IBM Plex Sans/Segoe UI the body stack, and IBM Plex Mono/SFMono the operational stack.
- Controls have a minimum 44 px hit target, visible focus rings, and explicit hover/pressed/disabled states.
- Forms use fieldsets and persistent labels; help, required state, and validation errors never depend on placeholders or color alone. Save, validation, and Doctor actions announce loading, success, and error states through an ARIA live region.
- Status cells collapse from four columns to two at tablet widths and one at 375 px and below.
- Wide audit data stays inside a keyboard-focusable horizontal scroller instead of expanding the page.

## Constraints

- No credential value is rendered. `neonxangi settings` exchanges a short-lived one-time ticket for an HttpOnly browser cookie, so the browser is authenticated automatically. The persistent management token never enters the URL or browser storage. A clearly explained manual recovery field appears only when the root URL is opened directly, and its value stays in memory until the tab closes.
- Credential configuration renders only a mode-0600 file path, dotenv key, and validation status. The UI states explicitly that saved runtime changes require a restart.
- Approval actions always show the operation and resource before the decision controls.
- Errors use an ARIA live alert, and reduced-motion preferences disable nonessential transitions.
- Mobile widths from 320 px through 414 px must have no document-level horizontal overflow.
- Navigation to hidden sections stays hidden before authentication. After authentication, settings, runtime status, permissions, and history remain reachable on desktop and mobile.
