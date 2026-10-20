/**
 * The ui package is typechecked on its own, so side-effect CSS imports in component source are parsed directly too.
 * Previously, only web/desktop declared *.css, causing TS2882 in this project when ui imported third-party styles.
 * Add the declaration for ui here so type checking matches how the bundler processes these imports.
 */
declare module "*.css";
