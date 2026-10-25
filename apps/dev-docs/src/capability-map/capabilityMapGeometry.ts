export const CAPABILITY_NODE_WIDTH = 264;
export const CAPABILITY_NODE_HEIGHT = 60;

// Cause: bilingual titles, owners, and LOC/in-degree/out-degree badges are taller than the old ELK
// top padding. The title box and child start position must share a constant, with the parent border
// deducted to keep spacing consistent.
export const CAPABILITY_HEADER_CONTENT_GAP = 12;
export const CAPABILITY_GROUP_FRAME_BORDER_WIDTH = 1;
export const CAPABILITY_GROUP_HEADER_HEIGHT = 112;
export const CAPABILITY_GROUP_CONTENT_TOP =
  CAPABILITY_GROUP_FRAME_BORDER_WIDTH +
  CAPABILITY_GROUP_HEADER_HEIGHT +
  CAPABILITY_HEADER_CONTENT_GAP;
export const CAPABILITY_SYSTEM_FRAME_BORDER_WIDTH = 2;
export const CAPABILITY_SYSTEM_HEADER_HEIGHT = 88;
export const CAPABILITY_SYSTEM_CONTENT_TOP =
  CAPABILITY_SYSTEM_FRAME_BORDER_WIDTH +
  CAPABILITY_SYSTEM_HEADER_HEIGHT +
  CAPABILITY_HEADER_CONTENT_GAP;
