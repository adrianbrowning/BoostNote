---
tags: [intro, markdown]
created: 2026-11-03T10:00:00Z
updated: 2026-11-25T16:45:00Z
---
# Markdown tour

Boostnote shows your Markdown as you type. Move the cursor into a line to see its **markers**, *emphasis*, ~~strike-through~~ and `inline code`.

## Links and images

Link to another note, like [Website redesign](Work/Projects/Website%20redesign.md), or to the web, like [the Boostnote repository](https://github.com/adrianbrowning/BoostNote).

![Notes written per month](Markdown%20tour.assets/chart.png)

## Tasks

- [x] Write the first note
- [x] Add a table
- [ ] Draw a diagram
- [ ] Share the vault as a website

## Table

| Shortcut | What it does |
| --- | --- |
| Type `/` | Opens the block menu |
| `**text**` | Bold text |
| `- [ ]` | A task |

## Math

The area of a circle is $A = \pi r^2$, and a sum looks like this:

$$
\sum_{k=1}^{n} k = \frac{n(n+1)}{2}
$$

## Diagram

```mermaid
flowchart LR
  Idea[Idea] --> Draft[Draft note]
  Draft --> Review{Ready?}
  Review -->|Yes| Share[Export]
  Review -->|No| Draft
```

## Code

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`
}
```

> A quote stays a quote, and a line of three dashes is a divider.

---
