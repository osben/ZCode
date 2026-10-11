export function resolveUpdateButtonResponsiveClasses({
  isMacDesktop,
  isWindowsDesktop,
}: {
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
}) {
  // Tailwind can collect only complete class names that appear in source.
  // Previously, after composing the container-query prefix as `${responsiveExpandClass}:...`,
  // the Windows branch’s `@min-[200px]/topoverlayer:*` classes never made it into the final CSS,
  // so the platform-specific behavior appeared not to work.
  if (isMacDesktop) {
    return {
      expandWidthClass: "@min-[280px]/topoverlayer:w-auto",
      hideIconClass: "@min-[280px]/topoverlayer:hidden",
      revealTextClass: [
        "@min-[280px]/topoverlayer:opacity-100",
        "@min-[280px]/topoverlayer:w-auto",
        "@min-[280px]/topoverlayer:relative",
      ],
    };
  }

  if (isWindowsDesktop) {
    return {
      expandWidthClass: "@min-[216px]/topoverlayer:w-auto",
      hideIconClass: "@min-[216px]/topoverlayer:hidden",
      revealTextClass: [
        "@min-[216px]/topoverlayer:opacity-100",
        "@min-[216px]/topoverlayer:w-auto",
        "@min-[216px]/topoverlayer:relative",
      ],
    };
  }

  return {
    expandWidthClass: "@min-[280px]/topoverlayer:w-auto",
    hideIconClass: "@min-[280px]/topoverlayer:hidden",
    revealTextClass: [
      "@min-[280px]/topoverlayer:opacity-100",
      "@min-[280px]/topoverlayer:w-auto",
      "@min-[280px]/topoverlayer:relative",
    ],
  };
}
