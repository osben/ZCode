# Remote Project Connection Details

The SSH-specific tooltip is replaced by the unified remote project details; the current contract is in
[flat project navigation, RDUX-12](../remote/project-first-remote-navigation-spec.md#21a-侧栏详情与设备菜单rdux-12).
SSH, WSL, Docker and Direct Server share one display model.

- Clicking the device label opens actionable details immediately; hovering 400ms opens the same popover,
  anchored at the right of the whole project row. Escape, an outside click or leaving an unpinned detail
  closes it; no hint remains after the menu closes.
- The details show project name, device name, connection description, the full remote path, and status
  with reason; never a password, private key path, passphrase or URL token. The session header name and
  path agree with it.
- Connect keeps the original project directory intent; disconnect acts on the device; edit reuses the
  connection edit dialog; manage goes to settings and scrolls to and focuses the target device card once.
- The display name does not take part in sorting, de-duplication or workspace identity computation; the
  popover belongs to the UI and does not change task, snapshot, queue, owner or the desktop continuous /
  mobile replayable chains.
