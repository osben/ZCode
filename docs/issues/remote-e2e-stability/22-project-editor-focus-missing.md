# Focus stays on the page body after opening the editor from the project menu

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test patch 08, batch
`r3-server-20261011143037600-31012b`; `uipairwise` failed after 132.2 s.

In the English, dark, 960x700 scenario, clicking Edit project in the real project menu shows the editor with
the right directory. The test waited 5 s for `activeElement` to be inside the visible editor; the final state
was `focusFailure={tag: "BODY", testId: null}` and the video end frame shows no focus ring on the editor
input. The input was not focused manually and the test did not fail on the first mount frame.

```text
project menu → Edit project → editor shown
  → wait for visible focus inside the editor (5 s)
  → activeElement still BODY
```

The `ProjectEditor` name input declares `autoFocus` and the project menu opens the editor via `onSelect`. The
order between menu-exit focus restoration and Dialog focus management must be checked; the evidence does not
yet identify a single callback. Business code is unchanged and the test does not force focus. The later
zh/light, offline and reconnect matrix is not reached.

This maps to the focus-usability requirement of
[R3A-UI-03](../../testing/r3-remote-automation-case-matrix.md). Evidence: `ui-pairwise.json`, failure video and
log of `uipairwise`.
