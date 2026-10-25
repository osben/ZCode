# Model Switch Toast

## Display Contract

- In an existing session, manually choosing a different model immediately shows a top-centered default Toast
  (text means "switched from A to B", the chosen model effective on the next send); an automatic fallback
  completion shows the same text. Neither waits for a send.
- Chinese text: `已从 {fromModel} 切换至 {toModel}`. English text: `Switched from {fromModel} to {toModel}`.
- `fromModel` and `toModel` keep the existing provider/model label formatting rules.
- The Toast only reports the switch result and adds no performance-impact note; the existing suppression rules
  such as re-selecting the same model in a draft are unchanged.

## Manual Selection Immediate Notice (ISSUE-035, 2026-10-22)

- A manual model selection (menu or shortcut) in an existing Session to a model different from the current one
  immediately shows the same switch Toast. The source model is the model the Composer displayed before the
  selection.
- Choosing a model in a new draft (no Session yet) shows nothing, unchanged.
- Sending no longer repeats the notice: the current code has no second switch notice at send time. The realtime
  switch event comes only from automatic fallback (`origin: registryFallback`), and its target is not the model
  the user just chose, so no suppression record is needed.
- If a send-time switch notice is added in the future, it must reuse SessionPane's same `showModelChangeNotice`
  entry and de-duplicate there, never starting another notification path.

| ID   | Action                                                   | Must observe                                                            |
| ---- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| MT01 | Choose a different model in an existing Session          | One switch Toast immediately; the Composer still shows the chosen model |
| MT02 | Send after MT01 and it is admitted                       | Still only the one Toast from MT01                                      |
| MT03 | After MT01, automatic fallback switches to another model | The fallback switch is notified as usual                                |
| MT04 | Choose a model in a new draft                            | No Toast                                                                |
