/** The research's hostile round-trip document (§9.3): markers, `1)` lists, setext, tables, autolinks, HTML. */
export const hostileRoundTripDocument = `Portfolio notes
===============

Intro paragraph with __strong__ text, _emphasis_ and a <br> inline break.

- dash item
+ plus item

1) first
2) second
    * nested four-space indent

- [ ] open task
- [x] done task

> quote line one
continued lazily

| Left | Center | Right |
|:-----|:------:|------:|
| a | b | c |

https://example.com/autolink and <https://example.com/angle>

Setext two
----------

\`\`\`js
# not a heading
const x = 1;
\`\`\`

***

Footnote reference[^1].

[^1]: The footnote text.
`;
