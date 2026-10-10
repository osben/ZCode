// Output the screen geometry of the System Settings main window so the CUA permission panel can
// snap to it.
//
// Why this is a separate binary: snapping needs only one value, the System Settings window bounds.
// The correct API, CGWindowListCopyWindowInfo, requires no TCC permission (only reading a window's
// image requires Screen Recording). This is essential because the permission guide runs before
// Accessibility or Screen Recording permissions have been granted. Electron has no binding for
// this API, and the alternatives do not work: osascript + System Events requires Accessibility
// permission, desktopCapturer returns the window name but not its bounds, and FFI libraries such as
// koffi are native addons that require electron-rebuild. So use a command-line program under 100 KB
// with no bundle.
//
// Keep the process running and output one JSON line per interval. The parent spawns it once and
// reads stdout; starting a process for each frame would cost about 10 ms seven times per second,
// which is unacceptable.
//
// Usage: zcode-window-bounds [intervalMs] (default: 150 ms)

import CoreGraphics
import Foundation

let intervalMs = UInt32(CommandLine.arguments.dropFirst().first.flatMap { UInt32($0) } ?? 150)
// The process name for System Settings varies by macOS version and language: macOS 13+ uses
// "System Settings", earlier versions use "System Preferences", and Chinese systems use a
// localized name.
let settingsOwners = ["System Settings", "System Preferences", "系统设置", "系統設定"]

// Use line buffering: the parent reads one line at a time, while default full buffering would
// leave data in the stdio buffer until it reaches 4 KB.
setvbuf(stdout, nil, _IOLBF, 0)

while true {
    var windows: [[String: Any]] = []

    if let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] {
        for window in list {
            guard let owner = window[kCGWindowOwnerName as String] as? String,
                settingsOwners.contains(where: { owner.contains($0) }),
                let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
                let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { continue }

            windows.append([
                "x": rect.origin.x,
                "y": rect.origin.y,
                "w": rect.size.width,
                "h": rect.size.height,
                // The consumer accepts only layer 0 (ordinary windows). The settings page also exposes auxiliary
                // layers above 0 (tooltips and pop-up selectors); snapping to one would send the panel to a screen
                // corner.
                "layer": window[kCGWindowLayer as String] as? Int ?? -1,
            ])
        }
    }

    // Output an empty array even when no window matches, so the parent can distinguish a closed
    // settings page from a failed probe.
    if let data = try? JSONSerialization.data(withJSONObject: windows),
        let line = String(data: data, encoding: .utf8)
    {
        print(line)
    }

    usleep(intervalMs * 1000)
}
