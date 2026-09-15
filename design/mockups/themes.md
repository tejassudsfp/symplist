# Theme design prompt — four styles, independent accents, paired light/dark modes

Use with [overall.md](overall.md). Design complete theme systems, with reusable component variants. The names below are starting directions; retain them for the first handoff so comparisons are easy.

## Shared principle

Calm usefulness with a little character. Cute means a small, intentional detail that rewards attention. It does not mean childish copy, animated helpers, sticker piles, or low-contrast pastel text. Every theme must remain comfortable for a long writing or agent-assisted work session.

Do not change information architecture between themes. A checkmark still completes a task, the agent stays on the right on desktop, and document actions stay discoverable. Themes may alter geometry and visual grouping without moving core controls unpredictably.

## Studio — standard, precise

The default. A clean sans-serif family, compact but comfortable task rows, continuous flat surfaces, fine separators, moderate corner radii, and mostly unboxed chat messages. Strong document hierarchy with generous line height. Minimal shadow; emphasis comes from type and alignment.

Light: neutral white/soft gray layers with a restrained blue or ink accent. Dark: distinguish charcoal layers clearly, avoiding pure-black slabs. Distinguishing signature: a quiet vertical selection marker and crisp, small controls. No decorative illustration is needed in populated views.

## Paper — standard, editorial

A reading-first theme. Serif document headings paired with a practical sans-serif UI, a subtly inset page, more generous document margins, slightly firmer corners, and understated rules. Controls remain recognizable and efficient. Chat feels like accompanying notes.

Light: warm cream paper with dark ink. Dark: warm charcoal with parchment-toned text; maintain rich visual separation without yellow haze. Distinguishing signature: editorial typography and fine ruled sections. Avoid literal torn paper, heavy textures, notebook spirals, or fake handwritten body text.

## Pebble — subtly quirky, soft

Friendly rounded geometry, a rounded sans-serif, roomier task rows, pill-like small controls, soft inset or raised panel framing, and compact rounded chat groups. Make the difference structural as well as chromatic.

Light: pale mineral surfaces and a muted sage or apricot accent. Dark: deep mineral surfaces, readable pale text, restrained accent highlights. Distinguishing signature: a small pebble-like selected marker and gently softened controls. A single two-shape pebble illustration can accompany an empty state. No bouncing blobs, jelly animations, or all-pastel text.

## Postcard — subtly quirky, graphic

A tidy stationery-inspired theme. Straightforward sans-serif body text, a little monospace for timestamps/metadata, firmer card outlines, small offset shadows, and a clipped-corner or tab detail on selected surfaces. Keep linework consistent, not wobbly.

Light: off-white, ink outlines, one faded coral/cobalt accent. Dark: deep blue-gray surfaces with quiet light outlines; offset shadows remain subtle rather than glowing. Distinguishing signature: one tiny stamp/tab motif on the collection title or empty state. No rotated text, scrapbook collage, distressed textures, or permanent sticker decorations in the editor.

## Specify for each theme

- Font stack and distribution/license considerations; fallback fonts. Include UI, headings, Markdown body, and code.
- Type scale, font weight, line height, paragraph width, row height, vertical rhythm, and padding.
- Page/inbox/chat surfaces; selected/hover/focus/disabled treatments; border strength, radii, shadows.
- Primary/secondary/destructive buttons, text inputs, menus, dialogs, tooltips, tabs, toggles, toasts, and skeletons.
- Task selection versus completion; nested row indentation; drag handles/drop targets.
- Markdown heading/list/table/blockquote/link/code appearances and selection toolbar.
- Chat messages, thinking/activity indicator without reasoning transcript, tool details, approvals, errors, and stopped output.
- Vault masked fields and plaintext reveal state, warnings, and confirmation dialogs.
- One optional illustrative motif, locations where it is allowed, and explicit limits on repetition.
- Motion timing and easing for ordinary transitions, with static reduced-motion equivalent. Motion cannot delay action or affect layout stability.

## Theme/mode controls

Appearance settings has three independent choices: a theme/style gallery, accent color (presets plus Custom), and Light / Dark / System. Each gallery card shows a miniature actual workspace with typography and panel treatment, not just a palette. Avoid eight separate theme cards; users choose style, accent, and mode independently. Indicate the selected theme through more than color.

Show the same content and dimensions across comparisons. Dark variants need intentional contrast and typography tuning, not inversion. Include at least one comparison at realistic laptop width to expose oversized spacing or poor information density.

## Required comparison boards

1. Studio, Paper, Pebble, and Postcard in Light, same populated Now workspace.
2. The same four in Dark with the same task selected.
3. All eight in task Page + Chat, showing a section-read activity and an approval.
4. All eight in Appearance settings and unlocked Vault list.
5. Shared accessibility state sheet: focus, error, disabled, selected, loading, drag target, destructive action.

Judge success by whether each theme has a recognizable personality while remaining equally usable. Studio and Paper should satisfy someone who wants familiar professional software. Pebble and Postcard should feel slightly playful without demanding attention.

## Accent system — required across every style

All color suggestions above are illustrative, not fixed theme pairings. Follow [the independent accent contract](../../docs/notes/files/02_themes.md). Design named presets and an accessible custom picker/hex input. Keep neutral surface character, type, shapes, and layout owned by the theme; derive interaction accents from the user's color with readable light/dark variants. Preserve semantic warning/error/success colors separately.

Extend comparison boards with one shared Violet accent across all four themes in both modes, then Blue/Green/Rose accents within the same Pebble workspace in both modes. Show extreme custom seeds (near-white, near-black, bright yellow) and how resolved tokens preserve contrast. Include token mappings for fills, text, links, subtle selection, focus, hover, and disabled states. Every theme supports every accent; these boards are samples, not an exhaustive list of separate themes. The original eight theme/mode boards remain the baseline, now rendered with a consistent stated accent.
