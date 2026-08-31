# Somnus Design System

Real tokens scraped from `somnia.network`'s own stylesheet (Next.js CSS).
Dark-only aesthetic: **"Somnia kinda UI"** — pure-black canvas, violet accent,
electric gradient family, lime spark.

## Color tokens

| Token | Hex | Usage |
|---|---|---|
| `--surface-page` | `#000000` | App / page background |
| `--surface-default` | `#141414` | Cards, sidebar |
| `--surface-raised` | `#1c1c1c` | Hover, raised cards, inputs |
| `--surface-overlay` | `#2f2f2f` | Modals, dropdowns |
| `--text-heading` | `#f5f5f5` | Headlines |
| `--text-body` | `#d3d3d3` | Body text |
| `--text-muted` | `#999999` | Secondary labels |
| `--text-subtle` | `#666666` | Captions, timestamps |
| `--border-default` | `#1c1c1c` | Hairlines, dividers |
| `--border-strong` | `#2f2f2f` | Focus rings, active borders |
| `--accent-primary` | `#771be8` | Primary CTAs, active states |
| `--accent-alt` | `#8e47ff` | Accent hover / gradient stops |
| `--up` (YES) | `#00c758` | YES buy button, up labels |
| `--down` (NO) | `#fb2c36` | NO buttons, down labels |
| `--spark` | `#adf03b` | Rare sparkle/highlight (from site HTML) |

## Gradient family (brand "aurora")

| Stop | Hex | Use |
|---|---|---|
| purple | `#ae00ff` | hero glow, logos |
| deep-purple | `#711aff` → `#8e47ff` | primary gradients |
| pink | `#ff00d5` | secondary accents, "agent" charm |
| ice-blue | `#00d4ff` | data/books glow |
| deep-blue | `#333aff` | deep surfaces glow |

Signature background gradient: `radial-gradient(1200px at 50% -20%, #711aff33, transparent 60%), #000`.

## Type
- Sans: system/Inter-style stack (site uses a default sans stack)
- Mono: `ui-monospace, SFMono-Regular, Menlo, Consolas` — **all numbers, prices, hashes**
- Numeric tabular: `font-variant-numeric: tabular-nums` for order books

## Shape / motion
- Radius: 12–14 px cards, 999 px pills/buttons
- Shadow: `inset 0 0 0 1px var(--border-strong)`, no blur drop shadows
- Motion: 150–200 ms ease-in-out; subtle (site uses `--ease-in-out`)

## Rules for the two pages
- **Landing:** page = `#000`, cards = `#141414`, accents = gradient (deep-purple→pink), CTA pill `#771be8` fading to `#8e47ff` on hover, sparcle `#adf03b` sparingly.
- **App:** page = `#000`, panels = `#141414`, raised = `#1c1c1c`, buy/sell columns green `#00c758` / red `#fb2c36`, PROOF log monospace, agent "status dot" = `#adf03b` breathing.
- Dark-only. `prefers-color-scheme: light` still gets the dark theme (brand decision).