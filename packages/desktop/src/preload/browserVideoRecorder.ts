import { ipcRenderer } from "electron";

const RECORDER_PORT_CHANNEL = "zcode-browser-video-recorder:port";

// A MessagePort cannot be proxied through contextBridge. This dedicated preload forwards only the port
// sent by main to the trusted recorder document; it does not expose ipcRenderer or generic Electron capabilities.
ipcRenderer.once(RECORDER_PORT_CHANNEL, (event) => {
  const [port] = event.ports;
  if (port) window.postMessage(RECORDER_PORT_CHANNEL, "*", [port]);
});
