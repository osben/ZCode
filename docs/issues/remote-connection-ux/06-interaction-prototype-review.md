# 06 — Interaction Prototype and Review

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:** none.

**Behavior to deliver:**

A temporary prototype page mounted in `pnpm dev:web` lets the user judge whether the new interaction is usable and good-looking before formal implementation.

- **Approach**: the prototype uses the project's real design tokens and base components with all data hard-coded; it can switch light and dark themes, a 264px sidebar width and a 900px window.
- **Use**: the review conclusion decides how [10](./10-three-screen-wizard-and-selection.md) to [13](./13-settings-device-cards-and-updates.md) are implemented.
- **Not merged**: the prototype code is not merged.

Scope:

- **Three-screen wizard**: select, connecting and choose-directory screens, with these states:
  - missing password
  - install confirmation
  - authentication failed
  - connection refused
  - deployment stage failed
  - already-online reuse notice
- **Sidebar**:
  - the 5 states of a project row and the detail card
  - the sidebar progress row after the wizard is collapsed
- **Session area**: disconnect banner and composer
- **Settings**:
  - device card
  - unfinished connection
  - update banner (one optional update, one required update)
- **Screenshot comparison**: the local dev walkthrough environment is still kept and can be compared side by side with the walkthrough screenshots.

Acceptance criteria (all met):

- The prototype page covers all screens and states listed above.
- Screenshots cover light and dark themes and the 264px sidebar and 900px window sizes, compared side by side with the walkthrough screenshots. Screenshots live in a temporary directory and are not committed.
- User review passed. The review conclusion is appended to `## Comments` at the end of this ticket.
- If the review changed an already-decided interaction decision, the corresponding fact spec is updated and noted in the affected tickets.
- Prototype code enters no commit and the working tree stays clean.

## Comments

### Review conclusion (2026-09-27, approved overall by the user)

The prototype was mounted at the temporary `?prototype=remote-ux` entry of `pnpm dev:web` and covered all screens and states in scope: 8 sidebar states, 12 wizard states, 4 Settings states. Screenshots covered dark/light themes × 1440 window (sidebar 264px) / 900px window, 96 in total, plus 24 side-by-side comparisons with walkthrough screenshots, all kept in a local temporary directory and not committed. After the review the prototype code was deleted and entered no commit.

**Implement as the prototype**: layout, information hierarchy, spacing and semantic colors of 10-13 follow the prototype; key points:

- **Wizard**: a three-segment progress hint at the top (select device → connect → choose directory); height adapts to content, and a long list scrolls inside the dialog.
- **Selection screen**: one searchable list grouped as "saved devices / Hosts in SSH config / WSL distributions (Windows only) / running containers"; a saved device shows its status on the right and lists recent directories as chips below; the bottom has "新建 SSH 连接" (new SSH connection) and a manual entry; the footer hints keyboard operation.
- **New SSH form**: host on its own row, username and port side by side; authentication as segmented buttons; password field with show/hide; "高级选项" (advanced options) collapsed; footer "返回列表" (back to list) on the left, "连接" (connect) on the right.
- **Connecting screen**: title is the device name plus a type tag, with a monospace address line below; stages are a vertical list with connecting lines, completed items show duration and the current item is bold; the install stage lists sub-steps, and uploading shows a progress bar, transferred size, speed and remaining time; wait points (password, install confirmation) and errors are embedded directly under the corresponding stage; the log is collapsed by default, expanded on failure, and "复制日志" (copy log) appears only after expanding.
- **Choose-directory screen**: the boundary note is a one-line dismissible hint; two chip rows "最近 / 远端记录" (recent / remote records); a path bar plus directory list, with "将打开 <完整路径>" (will open <full path>) at the bottom; footer "稍后选择" (choose later) on the left and "打开此目录" (open this directory) on the right; the device can be renamed directly under the title, with "已保存" (saved) after saving.
- **Sidebar**: a project row has only one status icon slot; online shows the device name in secondary text color, not online swaps in a short semantic-color status pill; row-end actions appear only on hover or focus. The detail card anchors to the whole row, pops out on the sidebar's right and does not cover row-end actions: the title row has the status tag on the right, followed by a reason block, a divider, device/connection/path and an action row.
- **Session area**: the top banner uses a semantic-color background as a whole; the title of a neutral state uses the primary text color; the composer keeps the draft and states the reason next to the send button when sending is impossible.

**Differences from the parent spec; this conclusion prevails**

1. The **collapsed progress row** becomes a two-line small card: the first line "正在连接 <设备名>…" (connecting <device name>…) and a percentage, the second line the current stage, and a progress bar below. A single-line form does not fit the 264px sidebar. After failure it stays as a danger-colored card stating the reason and clickable to view. Affects [10](./10-three-screen-wizard-and-selection.md).
2. On **authentication failure** the connecting screen re-enters the password or key passphrase in place, with the same interaction as "password required"; only changing the username or private key file returns to the form. The error classification table in the UX spec has been updated. Affects [11](./11-connecting-and-directory-screens.md).
3. **Stage names**: "确认连接" (confirm connection) is renamed "识别设备" (identify device), because the old name sounds like waiting for the user to confirm; the "连接就绪" (connection ready) stage is removed and success goes straight to the choose-directory screen or opens the project by intent. Affects [11](./11-connecting-and-directory-screens.md).
4. The secondary action copy on **deployment failure** becomes "改用设备直接下载" (download directly on the device instead). The UX spec has been updated. Affects [11](./11-connecting-and-directory-screens.md).

**Existing implementation to fix** (the prototype already draws the target look)

5. The device status label concatenates state and recovery progress directly, showing "连接中正在自动恢复连接（2/3）"; it should read "连接中 · 自动恢复 2/3". Affects [12](./12-sidebar-header-and-menus.md), [13](./13-settings-device-cards-and-updates.md).
6. A project row needs the short recovery copy "自动恢复 2/3"; the full sentence belongs only in the detail card. Affects [12](./12-sidebar-header-and-menus.md).
7. The connection description currently outputs `DOCKER · …`; it should use normal casing `Docker · …`. Affects [12](./12-sidebar-header-and-menus.md), [13](./13-settings-device-cards-and-updates.md).

**Confirmed visual trade-offs**

8. Primary actions on device cards (connect, retry, update remote, etc.) uniformly use outline buttons; urgency is carried by the status label and the in-card banner; only "新建连接" on the Settings page is a solid primary button. Affects [13](./13-settings-device-cards-and-updates.md).
9. **Required update**: status label + warning-colored banner explaining the version and impact + "更新远端" (update remote) at the card's top right; no button repeated inside the banner. **Optional update**: neutral banner with "稍后 / 更新" (later / update). Affects [13](./13-settings-device-cards-and-updates.md).
10. **Other connections**: the card's second line marks "当前 · 默认" (current · default); the expanded area lists only the remaining connections, with "设为默认 / 删除" (set as default / delete) always visible and not hover-dependent. Affects [13](./13-settings-device-cards-and-updates.md).
11. **Two session-area presentations**: on connection failure or reconnecting, already-loaded content is kept as a faded read-only view (still bound by "no new cache owner"); on user-initiated disconnect with no loaded content, show the placeholder "设备未连接，连接后继续此会话" (device not connected; continue this session after connecting). Affects [08](./08-disconnect-experience-and-in-place-reconnect.md).

**Not covered by the prototype**: the English UI, ↑↓ keyboard navigation on the selection screen, and the stage copy of WSL and Docker (only SSH was drawn), handled by [11](./11-connecting-and-directory-screens.md) and [14](./14-visual-polish-and-accessibility.md).
