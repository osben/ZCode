# Visualize Reply Reference Format

## Output convention

When the Visualize skill creates or updates a view, the final reply of the turn outputs `::visualize` plus a JSON object on a line of its own, using an absolute path under the session output directory provided by the execution side:

```text
::visualize{"path":"/absolute/session-dir/demo.html"}
::visualize{"path":"/absolute/session-dir/demo.html","mode":"wide"}
```

- Keep the two ASCII colons; do not generate Unicode private-use markers, and do not shorten to a bare `visualize`.
- The JSON contains only `path`, an optional `title` and an optional `mode: "wide"`.
- The reference in the actual reply has no backticks, is not placed in a code block, and is not placed in a progress message.
- File names, HTML fragments, the output directory and the completion-state requirements follow the existing Gen UI contract.

## Reason and compatibility

The model may omit or mistype the Unicode private-use delimiter, making the output unrecognizable as an interactive view reference. New replies uniformly use a visible ASCII directive prefix, to avoid generating references that depend on invisible delimiters.

The parser keeps accepting existing Unicode JSON references and the `::visualize{path="..."}` argument format; historical messages are not migrated, and path, argument, code-region exclusion and message completion gate rules are not relaxed. This change only adjusts the skill's output guidance; the existing support scope of desktop, remote workspace and Web/mobile is unchanged.

## Verification

- Extract the ordinary and wide-mode examples from the skill, replace the placeholder path and hand them to the existing reference parser, confirming a generated UI reference.
- Run `packages/ui/src/gen-ui/domain/references.test.ts`, covering JSON, the historical format, the streaming completion gate, code examples and illegal arguments.
- Check that the skill no longer contains the Unicode private-use delimiter or guidance requiring new replies to use Unicode.
