# Product

## Register

product

## Users

Health economics and outcomes research analysts, working inside a licensed
MarketScan environment. They are statisticians and epidemiologists, not
software engineers, and most of them write SAS by hand today.

Their context is not casual. They are usually mid-study, under a protocol that
somebody else wrote, with a deadline and a reviewer waiting. The screen is one
of many open windows and rarely the one they are looking at. They already know
what a propensity score is; nothing needs explaining to them except what THIS
program is about to do to their data.

The job: turn a protocol or SAP into SAS and SQL they are willing to put their
name on, without hand-writing it and without having to trust that the tool got
it right.

## Product Purpose

HEOR Studio turns a reviewed study specification into deterministic SAS and SQL
for MarketScan claims analyses, and proves the output is correct by executing it.

The differentiator is not that it generates code. It is that it refuses to
generate code it cannot verify, and says why. A language model drafts a
reviewable specification; deterministic emitters produce the code; the
specification is never the code's author. Every number the emitters can produce
is checked by running the actual generated SQL against a fixture with
hand-derived ground truth, and analyses that cannot be computed honestly are
refused before any code exists.

Success is an analyst reading a refusal, agreeing with it, and changing the
study rather than working around the tool.

## Brand Personality

**Precise. Quiet. Candid.**

A clinical instrument, not an application. It behaves like a well-made piece of
lab equipment: dense, legible, unhurried, with no ornament that is not carrying
information. Numbers and generated code are set in monospace because they are
specimens, not prose.

The voice states what will happen and what is not known. It never congratulates
the user, never uses an exclamation mark, and never softens a refusal into a
suggestion. When it will not do something it says so in one sentence and gives
the reason. When it is uncertain it says which part is uncertain.

Colour means something or it is absent. Green is agreement, amber is a caution
the analyst must resolve, red is a refusal. Nothing is coloured for decoration.

## Anti-references

- **Enterprise healthcare software** (Epic, Cerner, legacy clinical portals).
  Grey chrome, 11px type, toolbars stacked on toolbars, every surface a bordered
  table, information density achieved by shrinking rather than by editing. Dense
  is the goal; cramped is not.
- **Consumer app friendliness.** Rounded everything, illustrations of people,
  emoji as iconography, encouraging exclamation marks, celebratory empty states.
  Wrong register entirely for a tool whose main job is telling an expert that
  their study cannot be computed the way they asked.
- **Generic AI-generated SaaS.** Gradient text, hero metric blocks, identical
  card grids, tiny uppercase tracked eyebrows above every section.

## Design Principles

1. **Practice what you preach.** The product's claim is that it does not assert
   what it has not checked. The interface must hold the same line: no progress
   bar that is not measuring something, no "verified" badge that is not backed
   by a run, no state that looks settled when it is not.

2. **The refusal is a feature, so give it room.** Most tools bury the thing they
   cannot do. Here, refusals and limitations are the most valuable output on the
   screen and should be as legible as the results. An analyst who reads a
   refusal and changes their study got full value without generating a line of
   code.

3. **Density is respect.** These users read dense tables all day. Spacing exists
   to group and separate, not to make the page feel calm. Whitespace that
   pushes related things apart is a cost, not a virtue.

4. **One thing to do at a time.** The review gate is thirty-odd decisions. Shown
   as a wall it gets cleared without being read; shown one at a time with its
   evidence attached it gets read. Any surface that presents everything at once
   should be asked whether it is presenting or hiding.

5. **Never move a number quietly.** Anything that changes a computed result must
   be visible before it is accepted and attributable afterwards. This applies to
   the interface as much as to the emitters.

## Accessibility & Inclusion

WCAG 2.2 AA is the floor, and body text is held to 4.5:1 rather than the muted
grey that reads as elegant and fails.

- Every control reachable and operable by keyboard; focus rings are never
  removed, only restyled.
- Colour never carries meaning alone. A refusal is red AND says "REFUSED"; a
  caution is amber AND names what to resolve.
- Touch targets 44x44 minimum, with 8px between adjacent controls.
- `prefers-reduced-motion` is honoured on every transition.
- Generated code is presented as text, selectable and copyable, never as an
  image.
- The interface runs entirely in the browser with no telemetry, because these
  analysts work in environments where a document leaving the machine is a
  compliance incident, not a preference.
