# Sidebar UI polish

## Contract

The project action menu shows icons for pin/unpin, customization, and GitHub navigation. Opening it stops the trigger's pointer-down from reaching the sortable sensor, so moving the pointer after opening cannot start a row drag. While this menu is open, its project row does not register sortable drag listeners or show a grab cursor; closing the menu restores dragging. The menu owns its existing open state; no new persistence or protocol fields are introduced.

The conversation pinned-message strip keeps its accessible title on the container and its existing navigation/unpin actions, while omitting the redundant leading pin icon.

## Acceptance

- Opening a project action menu suppresses row drag activation; closing it restores the existing drag binding.
- A pointer move beyond the drag activation distance after pressing the menu trigger does not reorder the project row.
- Menu actions retain their labels and behavior.
- Pinned messages retain navigation, removal, and an accessible strip label.
