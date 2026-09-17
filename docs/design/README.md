# OmniBrowser visual specification

The primary screen concept in `omnibrowser-primary-screen.png` is the visual contract for the MVP shell. It is not shipped as application UI; every visible control, label, card, and canvas surface is implemented as native React/CSS UI around native Chromium views.

## Locked design system

- **Background:** cool graphite canvas (`#0b1118`) with a low-contrast 24 px dot grid.
- **Chrome:** near-black (`#101720`) with 1 px cool-gray separators.
- **Remote surfaces:** neutral white (`#ffffff`), never beige or cream.
- **Primary accent:** cobalt blue (`#1877f2`) for focus, selection, and the create action.
- **Profiles:** Personal blue, Trabajo amber, Private violet; profile colors remain identity accents, not global themes.
- **Typography:** Inter/system sans fallback, 11–14 px application chrome, strong but restrained card titles.
- **Geometry:** 10–12 px radii, 1 px borders, compact 32–36 px controls, hard-edged low-opacity shadows.
- **Container model:** open infinite canvas with a single profile rail and toolbar; browser cards are movable windows, not a dashboard grid.
- **Motion:** 140–180 ms focus/hover transitions; no decorative motion; respect reduced-motion preferences.

## Required primary-screen inventory

- Organization rail with Pinned, expandable profiles/zones/stacks, open browsers, search, and `+ Perfil`.
- Canvas toolbar with `Abrir navegador`, snap, recenter, zoom, and `Guardado`; URL/history controls belong to the active browser header.
- Multiple freely placed browser cards with profile identity and selected state.
- A semantic sleeping card, minimap, and concise canvas status line.
- Zone frames/chips, compact minimized cards, stack selector, multi-selection toolbar, viewport pins, and immersive full screen.
- Native Chromium content occupies only each card's interior rectangle; React owns headers, handles, toolbar, and overlays.
