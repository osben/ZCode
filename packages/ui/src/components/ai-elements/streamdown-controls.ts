// Interaction change: tables can already be browsed fully in the message stream, and a fullscreen entry interrupts that reading flow.
// Disable table enlargement here, keeping lightweight actions such as copy/export; message bodies and reasoning panels share this configuration.
export const STREAMDOWN_CONTROLS = {
  table: {
    fullscreen: false,
  },
} as const;
