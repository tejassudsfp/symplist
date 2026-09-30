# symplist — labels

Written September 30, 2026, after building them. This note is the binding decision for what a label is,
what it is not, and why the parts that look arbitrary are not.

## What a label is

A person's own word for a slice of their list. A short name, and one of the eight accent colours.

Nothing else. No hierarchy, no description, no icon, no per-label settings page, no smart labels, no
saved searches built on top of them. The founding idea is the tie-breaker here as everywhere: **the most
productive thing is often the most simple.** Every feature in the previous sentence exists in other
task apps, and every one of them is a thing a person has to maintain instead of doing their work.

Note 01 says "avoid mandatory tags, estimates, or priority configuration." Labels are the one exception,
and they earn it by being optional in both directions. An account with no labels sees no filter bar and
no chip; the list looks exactly as it did before labels existed. Nothing prompts for one, nothing is
sorted by one by default, and a task with no labels is not incomplete.

## A dot, not a pill

A label renders as a small coloured dot beside its name in the theme's own text colour. Not coloured
text. Not a coloured pill.

The reason is what eight of them look like at once. Coloured pills turn a calm list into a bar chart:
the eye goes to the loudest colour rather than to the next thing to do, and the label's text has to
survive a coloured background in six themes across light and dark, which is exactly where legibility
goes. A dot carries the same information — *which* label, at a glance, by colour — and costs the row
nothing. The name stays as readable as any other text on screen.

The eight colours are the accent presets, resolved per theme and mode through the same machinery that
resolves the account's accent, so each one meets 3:1 against every surface it is drawn on. A label's
colour is fixed and independent of the account's chosen accent: changing your accent does not repaint
your labels.

Custom hex colours are deliberately not offered, though appearance settings allow one for the accent.
A label is read at a glance against six themes; a free-form colour is the one thing a person can choose
that renders illegibly in half of them.

## The name is content; the colour is not

The name is encrypted at rest as a field envelope under the account data key, bound to owner, table, row
and column exactly as a task title is. A label name is as revealing as a task title — "Divorce", "Job
hunt", "Chemo" — and is treated the same way.

The colour is stored in the clear. It is one of eight preset names, not the person's writing, and
keeping it readable means a label list can be ordered and rendered without unwrapping a key.

**Uniqueness is enforced in the service, not by a database index**, and the encryption is why: envelopes
use a random IV, so the same word encrypts differently every time and `UNIQUE (owner_id, name_enc)`
would constrain nothing. The service reads the owner's labels — a few dozen rows, already in the tree
read — and compares decrypted names. Names are normalised (whitespace collapsed, ends trimmed) in the
service as well as in the schema, because that comparison *is* what uniqueness means here. The match is
case-insensitive and accent-preserving: "Work" and "work" are one label, "cafe" and "café" are two.

## Filtering narrows

Selecting a second label shows tasks carrying **both**, not either. That is what clicking two things in
a row looks like it should do, and a filter that widened as you added to it would be the opposite of
the gesture. Combined with the search field, both conditions must hold: the two controls are read as
one question, not as alternatives.

## Labels ride in the task tree response

They are not a separate endpoint the client has to keep in step. The tree response carries both the
owner's labels and each task's label ids, so a task row and the filter bar can never disagree about
what a task carries or which label comes first.

This has a consequence the implementation has to honour: **a label write is a tree change.** Every one
bumps the owner's task tree version and announces on the same signal an ordinary task write uses, so the
api's tree cache is evicted and the owner's other devices are told to re-read. A rename that skipped
either would leave the old name on screen until a cache entry aged out, and would never reach a second
device at all. Reads and writes each cost one D1 round trip; the new version is read back inside the
write's own batch (§3 budget lanes).

## Caps, and why each one exists

| Cap | Value | Why |
| --- | --- | --- |
| Name length | 32 characters | It has to fit a chip beside a task title. |
| Labels per owner | 60 | The filter bar renders every label, and uniqueness compares decrypted names; both are bounded by this rather than by the size of the list. |
| Labels per task | 8 | A task row must not become a wall of chips. |

## Made in Settings, not from a task row

Labels are created, renamed, recoloured and deleted in Settings → Labels. A task row can only put an
existing label on or take one off.

A label is vocabulary reused across the whole list. Letting one be invented from the row you happen to
be looking at is how a list ends up with "Work", "work" and "wrok" — three labels the person thinks are
one. The settings page shows how many active tasks carry each label, so an unused one is visible as such
before it is deleted. Delete offers Undo, and the toast says plainly that Undo brings the word back and
not the chips, because a silent partial undo is worse than a clear one.

## Over MCP: list, create, apply — never rename, never delete

A connected assistant gets three tools: `label_list`, `label_create`, and `task_set_labels`.

There is no `label_rename` and no `label_delete`. Either one changes every task carrying the label,
including tasks outside the grant, and a person's own words for their own list are not an agent's to
withdraw. Creating one is allowed because it is additive, and it requires all-task scope, because a
label belongs to the whole list rather than to the tasks a grant covers.

A grant restricted to particular tasks sees only the labels already on those tasks, with counts narrowed
to them. The rule is the one `McpTaskTools` already applies to parents and siblings: a selected child
does not grant its neighbours. A grant over three tasks is not a reason to learn the whole of someone's
vocabulary.

`task_set_labels` replaces the whole set rather than adding and removing one at a time. That is what
makes it idempotent, what makes it safe to retry without a request id, and what makes two surfaces
editing at once — a task row and a connected assistant — settle on a state the person can see instead of
on the difference of two deltas neither of them sent. `label_create` resolves a name already in use to
the label that has it, for the same reason: a call whose response was lost asks again and is told the id
its first attempt made.

## What is deliberately not built

- **Labels in the archive.** A completed task keeps its rows, but the archive shows no chips and no
  filter. The archive is a record of what was done, not a place you slice by vocabulary.
- **Label groups, colours beyond the eight, per-label notification rules, sorting by label.** Each is a
  thing to maintain. If one turns out to be missed, it can be added; none of them can be un-added.

Symplist is open source under the [MIT License](../../../LICENSE), copyright 2026
[Tejas Parthasarathi Sudarshan](https://tejassuds.com).
