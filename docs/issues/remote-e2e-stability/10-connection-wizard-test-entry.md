# The Connection Wizard Case Used the Project Creation Entry by Mistake

Status: done

## Cause and Fix

On business baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, creation in the project area selected only the Host through `ProjectConnection` and then entered `RemoteProjectPicker`. Settings "新建连接" is the independent wizard that keeps the three-screen directory step. The old `boundary` case connected through the shared project entry but kept waiting for the old wizard's `remote-boundary-hint`, hence reporting the hint missing by mistake.

The recordings of batches `r3-server-20261011101534847-c8a52a` and `r3-server-20261011102656782-52518d` show the "添加远程项目" (add remote project) list, not the directory page this case wants to verify. The fix makes the wizard-specific case choose the Settings entry explicitly and continue along the real directory selection, project save and in-project new-task flow; ordinary SSH business cases keep the project entry.

## Re-verification and Boundary

- The regression test first proved the old helper ignored the entry choice and still took the project path, and it passes after the fix.
- `boundary-ack.json` of `r3-server-20261011104332183-3a0c00` actually records the first explanatory text, the project A identity and `secondProjectHintAbsent=true`; the onboarding version stays 2.
- The missing hint was not a business defect of the Settings connection wizard. Whether the new project path should also carry the same explanation is a separate product discussion, and this round does not modify business code or delete the hint assertion because of the old case's entry mistake.
- The full case still FAILs: the saved connection lacks credentials after a cold restart, see [issue 11](11-ssh-credential-missing-after-restart.md). The passing first half is not described as the whole case PASS.
