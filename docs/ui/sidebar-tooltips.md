# Left Sidebar Hover Tooltips

## Behavior

Tooltips in the left project/task navigation, groups and timeline, the bottom account/settings/mobile
remote entries, the file tree, and the top-left sidebar and task navigation tool area all appear after the
mouse dwells continuously for **300ms**.

```text
enter trigger -> Radix timer 300ms -> show tooltip
       └─ leave early -> cancel
switch trigger -> restart 300ms (delay not skipped)
```

1. The shared sidebar Tooltip Provider configures the delay, `skipDelayDuration=0` and a strict delay
   policy. Inside the strict scope each tooltip uses an independent Radix timer, so shared fast-open state
   cannot bypass the delay within one pointer movement; no per-tooltip Provider is added outside the
   sidebar. Timing, leave-to-cancel and keyboard focus stay Radix; no business timer is added.
2. A plain tooltip only shows an explanation and closes when leaving the trigger; it enables no hover
   corridor into the tooltip content and its popover does not intercept mouse events, so an old tooltip
   does not block a neighbor button's new one. Interactive remote details keep using the original
   HoverCard (already 300ms; close delay and in-detail copy interaction unchanged).
3. Project row "more / show file tree / new task", section and group actions, task actions and status,
   workflow info, bottom entries, file tree buttons and Git status all inherit the policy. A grouped task's
   whole row must not override it with an independent zero-delay Provider.
4. The new-project button of the "Projects" section and the new-task button of the "Tasks" section get
   tooltips, reusing existing i18n copy and accessible names.
5. Native sidebar `title` hints move to the shared Tooltip: group names, draft name/directory, old project
   notes, home-only workspaces, file paths, file tree more / clear search, account info and menu disabled
   reasons. Trigger size, drag, click and keyboard behavior are kept.
6. A plain task title already has 1-second hover scrolling and gets no title Tooltip; open timing of click
   menus, Popovers and Dialogs is unchanged. Tooltips outside the sidebar keep the original policy.
7. The mouse-hover delay does not change keyboard focus tooltips or touch tap behavior. Desktop and mobile
   share the component; zh/en and Zai Light / Dark apply.

## Verification

- SBT01: a brief pass shows nothing; dwelling shows it; adjacent buttons each wait anew; leaving cancels.
- SBT02: the three project row buttons, the project/task section new buttons, search/filter and bottom
  entry copy are correct and click still performs the original action.
- SBT03: whole group row/actions, native tooltip migration, file tree and remote details follow 300ms;
  tooltips outside the sidebar keep the original policy.
- SBT04: desktop/mobile layout, zh/en and light/dark; touch taps need not wait for the tooltip, keyboard
  availability is kept.

The browser candidate mounts the real production components with injected service data; the Desktop
candidate verifies the full app entry. Candidates stay manual-review/pending and a browser fixture does not
replace remote transport or native multi-platform verification.
